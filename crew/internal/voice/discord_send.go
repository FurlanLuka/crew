package voice

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// Discord's own limits for a bot message on a server without boosts.
const (
	MaxDiscordText  = 2000
	MaxDiscordFiles = 10
	MaxDiscordFile  = 10 << 20
)

// longTextFile is what text over MaxDiscordText is sent as: one attachment, never a run of messages.
const longTextFile = "message.md"

// discordSendClient waits longer than the reads: ten files of 10 MB go up in one request.
var discordSendClient = &http.Client{Timeout: 2 * time.Minute}

// discordRetryWait caps how long a 429 is waited out; a var so tests do not wait.
var discordRetryWait = 10 * time.Second

// DiscordMessage is what crew server discord send posts.
type DiscordMessage struct {
	Text  string
	Files []string
}

// DiscordSent is the posted message, for the caller to say.
type DiscordSent struct {
	Channel     string `json:"channel"`
	ChannelName string `json:"channel_name"`
	Message     string `json:"message"`
	Link        string `json:"link"`
	Files       int    `json:"files"`
	// The text went as message.md: it was longer than Discord takes in one message.
	TextAttached bool `json:"text_attached"`
	// Posted in the voice channel's own chat: no text channel was picked.
	IsVoiceChat bool `json:"is_voice_chat"`
}

// ErrDiscordNotSetUp: there is nothing to post with.
var ErrDiscordNotSetUp = errors.New("Discord is not set up here — crew server discord setup")

type attachment struct {
	name string
	data []byte
}

// CheckDiscordLimits checks every limit from the files' sizes alone, before anything is read or sent:
// a message is posted whole or not at all.
func CheckDiscordLimits(msg DiscordMessage) error {
	text := strings.TrimSpace(msg.Text)
	if text == "" && len(msg.Files) == 0 {
		return errors.New("nothing to send: give --text, --file, or text on stdin")
	}
	count := len(msg.Files)
	if isLongText(text) {
		count++
	}
	if count > MaxDiscordFiles {
		return fmt.Errorf("%d files: Discord takes at most %d in one message", count, MaxDiscordFiles)
	}
	for _, path := range msg.Files {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("cannot read %s: %w", path, err)
		}
		if info.IsDir() {
			return fmt.Errorf("%s is a folder: send the files in it", path)
		}
		if info.Size() > MaxDiscordFile {
			return fmt.Errorf("%s is %s: Discord takes at most %s per file", path, formatBytes(info.Size()), formatBytes(MaxDiscordFile))
		}
	}
	return nil
}

func isLongText(text string) bool { return len([]rune(text)) > MaxDiscordText }

// planDiscordMessage reads a message that passed its limits. Text past Discord's limit goes as
// message.md beside the files.
func planDiscordMessage(msg DiscordMessage) (content string, files []attachment, err error) {
	if err := CheckDiscordLimits(msg); err != nil {
		return "", nil, err
	}
	text := strings.TrimSpace(msg.Text)
	for _, path := range msg.Files {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", nil, fmt.Errorf("cannot read %s: %w", path, err)
		}
		files = append(files, attachment{name: filepath.Base(path), data: data})
	}
	if isLongText(text) {
		files = append(files, attachment{name: longTextFile, data: []byte(text + "\n")})
		return "", files, nil
	}
	return text, files, nil
}

func formatBytes(n int64) string {
	if n >= 1<<20 {
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	}
	return strconv.FormatInt(n/1024, 10) + " KB"
}

func buildDiscordBody(content string, files []attachment) (*bytes.Buffer, string, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	type attachmentMeta struct {
		ID       int    `json:"id"`
		Filename string `json:"filename"`
	}
	payload := struct {
		Content     string           `json:"content,omitempty"`
		Attachments []attachmentMeta `json:"attachments,omitempty"`
		// Mentions in a session's text never ping anyone.
		AllowedMentions map[string][]string `json:"allowed_mentions"`
	}{Content: content, AllowedMentions: map[string][]string{"parse": {}}}
	for i, f := range files {
		payload.Attachments = append(payload.Attachments, attachmentMeta{ID: i, Filename: f.name})
	}
	meta, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	if err := w.WriteField("payload_json", string(meta)); err != nil {
		return nil, "", err
	}
	for i, f := range files {
		part, err := w.CreateFormFile(fmt.Sprintf("files[%d]", i), f.name)
		if err != nil {
			return nil, "", err
		}
		if _, err := part.Write(f.data); err != nil {
			return nil, "", err
		}
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return &body, w.FormDataContentType(), nil
}

// postDiscordMessage posts once, and once more after a 429's retry_after. The token and the
// message's words are never logged.
func postDiscordMessage(token, channel, content string, files []attachment) (string, error) {
	path := "/channels/" + channel + "/messages"
	for attempt := 0; ; attempt++ {
		body, contentType, err := buildDiscordBody(content, files)
		if err != nil {
			return "", err
		}
		req, err := http.NewRequest(http.MethodPost, discordAPI+path, body)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bot "+token)
		req.Header.Set("Content-Type", contentType)
		debug.Log("voice", "discord: POST %s (%d chars, %d files, %d bytes)", path, len(content), len(files), body.Len())
		resp, err := discordSendClient.Do(req)
		if err != nil {
			debug.Log("voice", "discord: POST %s: %v", path, err)
			return "", fmt.Errorf("could not reach Discord: %w", err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		debug.Log("voice", "discord: POST %s: %d", path, resp.StatusCode)
		switch {
		case resp.StatusCode == http.StatusTooManyRequests && attempt == 0:
			time.Sleep(readRetryAfter(raw))
			continue
		case resp.StatusCode == http.StatusUnauthorized:
			return "", ErrDiscordRejected
		case resp.StatusCode == http.StatusForbidden:
			return "", errors.New("Discord refused: the bot may not post or attach files in that channel — give its role Send Messages and Attach Files there")
		case resp.StatusCode == http.StatusRequestEntityTooLarge:
			return "", errors.New("Discord refused the files as too large for this server")
		case resp.StatusCode < 200 || resp.StatusCode >= 300:
			return "", fmt.Errorf("Discord answered %d to the message", resp.StatusCode)
		}
		var sent struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &sent); err != nil {
			return "", fmt.Errorf("Discord answered something unreadable: %w", err)
		}
		return sent.ID, nil
	}
}

func readRetryAfter(raw []byte) time.Duration {
	var limited struct {
		RetryAfter float64 `json:"retry_after"`
	}
	_ = json.Unmarshal(raw, &limited)
	wait := time.Duration(limited.RetryAfter * float64(time.Second))
	if wait <= 0 || wait > discordRetryWait {
		return discordRetryWait
	}
	return wait
}

// SendDiscord posts a message where discord.json says messages go, with the saved token. Only the
// machine that holds the token sends: a remote hands its message to the main.
func SendDiscord(msg DiscordMessage) (DiscordSent, error) {
	report, err := InspectDiscord()
	if err != nil {
		return DiscordSent{}, err
	}
	if !report.SetUp || report.Config == nil {
		return DiscordSent{}, ErrDiscordNotSetUp
	}
	content, files, err := planDiscordMessage(msg)
	if err != nil {
		return DiscordSent{}, err
	}
	channel, name := MessagesChannel(*report.Config)
	id, err := postDiscordMessage(SavedDiscordToken(), channel, content, files)
	if err != nil {
		return DiscordSent{}, err
	}
	return DiscordSent{
		Channel:      channel,
		ChannelName:  name,
		Message:      id,
		Link:         fmt.Sprintf("https://discord.com/channels/%s/%s/%s", report.Config.Guild, channel, id),
		Files:        len(msg.Files),
		TextAttached: content == "" && strings.TrimSpace(msg.Text) != "",
		IsVoiceChat:  report.Config.TextChannel == "",
	}, nil
}

// DiscordChannels lists where messages can go, for Set up's picker: the channels the bot sees that
// take messages, with the voice channel's own chat among them.
func DiscordChannels() ([]DiscordChannelRow, error) {
	report, err := InspectDiscord()
	if err != nil {
		return nil, err
	}
	if !report.SetUp || report.Config == nil {
		return nil, ErrDiscordNotSetUp
	}
	var all []discordChannel
	if err := discordGet(SavedDiscordToken(), "/guilds/"+report.Config.Guild+"/channels", &all); err != nil {
		return nil, err
	}
	current, _ := MessagesChannel(*report.Config)
	rows := []DiscordChannelRow{}
	for _, c := range MessageChannels(all) {
		kind := "text"
		if c.Type == discordVoiceChannel {
			kind = "voice"
		}
		rows = append(rows, DiscordChannelRow{
			ID:        c.ID,
			Name:      c.Name,
			Kind:      kind,
			IsVoice:   c.ID == report.Config.Channel,
			IsCurrent: c.ID == current,
		})
	}
	return rows, nil
}

// DiscordChannelRow is one row of crew server discord channels.
type DiscordChannelRow struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	// The voice channel Voice OS joins: its chat is where messages go by default.
	IsVoice   bool `json:"is_voice"`
	IsCurrent bool `json:"is_current"`
}
