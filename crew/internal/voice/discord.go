package voice

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// DiscordKey is the bot token's key file. It is not in KeyNames: Discord is
// optional, so the first `crew server` must never ask for it.
const DiscordKey = "discord"

// discordAPI is a var so tests point it at a local server.
var discordAPI = "https://discord.com/api/v10"

var discordClient = &http.Client{Timeout: 10 * time.Second}

// ErrDiscordRejected is Discord saying no to the token itself.
var ErrDiscordRejected = errors.New("Discord rejected that token — copy it again from your app's Bot tab (Reset Token) and rerun crew server discord setup")

// The bits Voice OS needs to join and speak; Administrator grants all of them.
const (
	permAdministrator = 1 << 3
	permViewChannel   = 1 << 10
	permSendMessages  = 1 << 11
	permAttachFiles   = 1 << 15
	permConnect       = 1 << 20
	permSpeak         = 1 << 21
)

type discordPerm struct {
	bit  uint64
	name string
}

var neededPerms = []discordPerm{
	{permViewChannel, "View Channel"},
	{permConnect, "Connect"},
	{permSpeak, "Speak"},
}

// preferredChannel is the voice channel picked over any other when it exists.
const preferredChannel = "Voice OS"

const (
	discordTextChannel         = 0
	discordVoiceChannel        = 2
	discordAnnouncementChannel = 5
)

// TextChannelVoice is --text-channel's word for "back to the voice channel's own chat".
const TextChannelVoice = "voice"

// What crew server discord send needs on the channel it posts to.
var sendPerms = []discordPerm{
	{permViewChannel, "View Channel"},
	{permSendMessages, "Send Messages"},
	{permAttachFiles, "Attach Files"},
}

// DiscordConfig is discord.json: where Voice OS joins and whose voice it takes.
// A running Voice OS watches the file.
type DiscordConfig struct {
	Guild       string `json:"guild"`
	Channel     string `json:"channel"`
	ChannelName string `json:"channel_name"`
	GuildName   string `json:"guild_name"`
	Owner       string `json:"owner"`
	// Where crew server discord send posts; empty is the voice channel's own chat.
	TextChannel     string `json:"text_channel,omitempty"`
	TextChannelName string `json:"text_channel_name,omitempty"`
}

// MessagesChannel is where a sent message goes: the text channel picked, else the voice channel's
// own chat (every voice channel has one). Pure.
func MessagesChannel(cfg DiscordConfig) (id, name string) {
	if cfg.TextChannel != "" {
		return cfg.TextChannel, cfg.TextChannelName
	}
	return cfg.Channel, cfg.ChannelName
}

// DiscordLive is discord-status.json, written by Voice OS.
type DiscordLive struct {
	Connected      bool   `json:"connected"`
	OwnerInChannel bool   `json:"owner_in_channel"`
	Error          string `json:"error"`
	At             string `json:"at"`
}

type DiscordOptions struct {
	Guild   string
	Channel string
	User    string
	// Empty keeps the text channel already picked; TextChannelVoice goes back to the voice chat.
	TextChannel string
}

// DiscordSetup is what setup decided, for the caller to say.
type DiscordSetup struct {
	Config DiscordConfig
	// OwnerGiven: --user named the voice to take, rather than the server owner.
	OwnerGiven bool
}

// DiscordReport is `crew server discord status`: nil parts are absent.
type DiscordReport struct {
	SetUp  bool           `json:"set_up"`
	Token  bool           `json:"token"`
	Config *DiscordConfig `json:"config"`
	Live   *DiscordLive   `json:"live"`
}

type discordGuild struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Permissions string `json:"permissions"`
}

type discordChannel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type int    `json:"type"`
}

func DiscordFile() string       { return filepath.Join(Dir(), "discord.json") }
func DiscordStatusFile() string { return filepath.Join(Dir(), "discord-status.json") }

// SavedDiscordToken is the token kept from an earlier setup, or "".
func SavedDiscordToken() string { return readKey(DiscordKey) }

// discordGet is every call to Discord. The token is never logged.
func discordGet(token, path string, out any) error {
	req, err := http.NewRequest(http.MethodGet, discordAPI+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bot "+token)
	debug.Log("voice", "discord: GET %s", path)
	resp, err := discordClient.Do(req)
	if err != nil {
		debug.Log("voice", "discord: GET %s: %v", path, err)
		return fmt.Errorf("could not reach Discord: %w", err)
	}
	defer resp.Body.Close()
	debug.Log("voice", "discord: GET %s: %d", path, resp.StatusCode)
	switch {
	case path == "/users/@me" && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden):
		return ErrDiscordRejected
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return fmt.Errorf("Discord answered %d to GET %s", resp.StatusCode, path)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// SetupDiscord checks the token with Discord, saves it once Discord takes it
// (so a rerun with --guild or --channel needs no paste), then decides the
// server, the voice to take and the channel, and writes discord.json only when
// every one is decided and the bot may join and speak there.
func SetupDiscord(token string, opts DiscordOptions) (DiscordSetup, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return DiscordSetup{}, errors.New("no token given")
	}
	var bot struct {
		ID string `json:"id"`
	}
	if err := discordGet(token, "/users/@me", &bot); err != nil {
		return DiscordSetup{}, err
	}
	if err := SaveKey(DiscordKey, token); err != nil {
		return DiscordSetup{}, err
	}

	var guilds []discordGuild
	if err := discordGet(token, "/users/@me/guilds", &guilds); err != nil {
		return DiscordSetup{}, err
	}
	guild, err := pickGuild(guilds, opts.Guild)
	if err != nil {
		return DiscordSetup{}, err
	}
	if missing := missingPerms(guild.Permissions, neededPerms); len(missing) > 0 {
		return DiscordSetup{}, fmt.Errorf("the bot lacks %s on %s — give its role %s, or invite it again with View Channel, Connect and Speak",
			strings.Join(missing, ", "), guild.Name, strings.Join(missing, ", "))
	}

	owner := strings.TrimSpace(opts.User)
	if owner == "" {
		var full struct {
			OwnerID string `json:"owner_id"`
		}
		if err := discordGet(token, "/guilds/"+guild.ID, &full); err != nil {
			return DiscordSetup{}, err
		}
		owner = full.OwnerID
	}

	var channels []discordChannel
	if err := discordGet(token, "/guilds/"+guild.ID+"/channels", &channels); err != nil {
		return DiscordSetup{}, err
	}
	channel, err := pickChannel(channels, guild.Name, opts.Channel)
	if err != nil {
		return DiscordSetup{}, err
	}
	text, err := decideTextChannel(channels, guild, opts.TextChannel)
	if err != nil {
		return DiscordSetup{}, err
	}

	cfg := DiscordConfig{Guild: guild.ID, GuildName: guild.Name, Channel: channel.ID, ChannelName: channel.Name, Owner: owner, TextChannel: text.ID, TextChannelName: text.Name}
	if err := writeDiscordConfig(cfg); err != nil {
		return DiscordSetup{}, err
	}
	return DiscordSetup{Config: cfg, OwnerGiven: opts.User != ""}, nil
}

func pickGuild(guilds []discordGuild, want string) (discordGuild, error) {
	if want != "" {
		for _, g := range guilds {
			if g.ID == want {
				return g, nil
			}
		}
		if len(guilds) == 0 {
			return discordGuild{}, fmt.Errorf("the bot is in no server — invite it to %s first (OAuth2 → URL Generator: bot, with View Channel, Connect, Speak)", want)
		}
		return discordGuild{}, fmt.Errorf("the bot is not in server %s; it is in:\n%s", want, guildList(guilds))
	}
	switch len(guilds) {
	case 0:
		return discordGuild{}, errors.New("the bot is in no server yet — invite it to yours (Developer Portal → OAuth2 → URL Generator: scope bot, with View Channel, Connect, Speak), then rerun")
	case 1:
		return guilds[0], nil
	}
	return discordGuild{}, fmt.Errorf("the bot is in %d servers — say which with --guild=<id>:\n%s", len(guilds), guildList(guilds))
}

func guildList(guilds []discordGuild) string {
	lines := make([]string, 0, len(guilds))
	for _, g := range guilds {
		lines = append(lines, g.ID+"\t"+g.Name)
	}
	return strings.Join(lines, "\n")
}

// pickChannel: --channel by id or name; else "Voice OS"; else the only voice channel.
func pickChannel(all []discordChannel, guildName, want string) (discordChannel, error) {
	var voice []discordChannel
	for _, c := range all {
		if c.Type == discordVoiceChannel {
			voice = append(voice, c)
		}
	}
	sort.SliceStable(voice, func(i, j int) bool { return voice[i].Name < voice[j].Name })
	if len(voice) == 0 {
		return discordChannel{}, fmt.Errorf("%s has no voice channel — create one (\"%s\" is picked first), then rerun", guildName, preferredChannel)
	}
	want = strings.TrimSpace(want)
	if want != "" {
		for _, c := range voice {
			if c.ID == want || strings.EqualFold(c.Name, want) {
				return c, nil
			}
		}
		return discordChannel{}, fmt.Errorf("no voice channel %q on %s; its voice channels:\n%s", want, guildName, channelList(voice))
	}
	for _, c := range voice {
		if strings.EqualFold(c.Name, preferredChannel) {
			return c, nil
		}
	}
	if len(voice) == 1 {
		return voice[0], nil
	}
	return discordChannel{}, fmt.Errorf("%s has %d voice channels and none named %q — say which with --channel=<name|id>:\n%s",
		guildName, len(voice), preferredChannel, channelList(voice))
}

func channelList(channels []discordChannel) string {
	lines := make([]string, 0, len(channels))
	for _, c := range channels {
		lines = append(lines, c.ID+"\t"+c.Name)
	}
	return strings.Join(lines, "\n")
}

// decideTextChannel: --text-channel by name or id among the channels a message can go to; "voice"
// clears it; nothing given keeps the one an earlier setup picked (a rerun for another reason never
// moves where messages go). The bot must be able to post there.
func decideTextChannel(all []discordChannel, guild discordGuild, want string) (discordChannel, error) {
	want = strings.TrimSpace(want)
	if want == "" {
		kept, err := readJSONFile[DiscordConfig](DiscordFile())
		if err != nil || kept == nil || kept.Guild != guild.ID {
			return discordChannel{}, err
		}
		return discordChannel{ID: kept.TextChannel, Name: kept.TextChannelName}, nil
	}
	if missing := missingPerms(guild.Permissions, sendPerms); len(missing) > 0 {
		return discordChannel{}, fmt.Errorf("the bot lacks %s on %s — give its role %s so crew server discord send can post",
			strings.Join(missing, ", "), guild.Name, strings.Join(missing, ", "))
	}
	if strings.EqualFold(want, TextChannelVoice) {
		return discordChannel{}, nil
	}
	postable := MessageChannels(all)
	if c, ok := findMessageChannel(postable, strings.TrimPrefix(want, "#")); ok {
		return c, nil
	}
	return discordChannel{}, fmt.Errorf("no channel %q on %s to post in; its channels:\n%s", want, guild.Name, channelList(postable))
}

// findMessageChannel: by id, then the name as written, then the name in any case — a text channel
// before a voice channel of the same name ("general" the text channel over "General" the voice one).
func findMessageChannel(postable []discordChannel, want string) (discordChannel, bool) {
	matches := []func(discordChannel) bool{
		func(c discordChannel) bool { return c.ID == want },
		func(c discordChannel) bool { return c.Name == want },
		func(c discordChannel) bool { return c.Type != discordVoiceChannel && strings.EqualFold(c.Name, want) },
		func(c discordChannel) bool { return strings.EqualFold(c.Name, want) },
	}
	for _, match := range matches {
		for _, c := range postable {
			if match(c) {
				return c, true
			}
		}
	}
	return discordChannel{}, false
}

// MessageChannels are the channels a message can go to: text and announcement channels, and the voice
// channels' own chats. Sorted by name. Pure.
func MessageChannels(all []discordChannel) []discordChannel {
	var out []discordChannel
	for _, c := range all {
		switch c.Type {
		case discordTextChannel, discordAnnouncementChannel, discordVoiceChannel:
			out = append(out, c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// missingPerms reads the bot's server-wide permissions; channel overwrites are
// left to Voice OS, which says so when it cannot join.
func missingPerms(raw string, needed []discordPerm) []string {
	bits, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		names := make([]string, 0, len(needed))
		for _, p := range needed {
			names = append(names, p.name)
		}
		return names
	}
	if bits&permAdministrator != 0 {
		return nil
	}
	var missing []string
	for _, p := range needed {
		if bits&p.bit == 0 {
			missing = append(missing, p.name)
		}
	}
	return missing
}

// writeDiscordConfig writes aside and renames in, so a watching Voice OS never
// reads half a file.
func writeDiscordConfig(cfg DiscordConfig) error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(DiscordFile(), append(data, '\n')); err != nil {
		return err
	}
	debug.Log("voice", "discord.json: guild %s, channel %s", cfg.Guild, cfg.Channel)
	return nil
}

func readJSONFile[T any](path string) (*T, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return &v, nil
}

func InspectDiscord() (DiscordReport, error) {
	cfg, err := readJSONFile[DiscordConfig](DiscordFile())
	if err != nil {
		return DiscordReport{}, err
	}
	live, err := readJSONFile[DiscordLive](DiscordStatusFile())
	if err != nil {
		return DiscordReport{}, err
	}
	token := SavedDiscordToken() != ""
	return DiscordReport{SetUp: cfg != nil && token, Token: token, Config: cfg, Live: live}, nil
}

// DiscordStatusRows is the status table, <field>\t<value> per row. Pure.
func DiscordStatusRows(r DiscordReport) [][2]string {
	setup := "not set up (crew server discord setup)"
	switch {
	case r.SetUp:
		setup = "ready"
	case r.Config != nil:
		setup = "no token (crew server discord setup)"
	}
	token := "missing"
	if r.Token {
		token = "set"
	}
	rows := [][2]string{{"setup", setup}, {"token", token}}
	if r.Config != nil {
		rows = append(rows,
			[2]string{"server", r.Config.GuildName + " (" + r.Config.Guild + ")"},
			[2]string{"channel", r.Config.ChannelName + " (" + r.Config.Channel + ")"},
			[2]string{"messages", describeMessagesChannel(*r.Config)},
			[2]string{"owner", r.Config.Owner},
		)
	}
	if r.Live == nil {
		return append(rows, [2]string{"live", "Voice OS has not reported"})
	}
	rows = append(rows,
		[2]string{"connected", yesNo(r.Live.Connected)},
		[2]string{"owner_in_channel", yesNo(r.Live.OwnerInChannel)},
	)
	if r.Live.Error != "" {
		rows = append(rows, [2]string{"error", r.Live.Error})
	}
	return append(rows, [2]string{"at", r.Live.At})
}

func describeMessagesChannel(cfg DiscordConfig) string {
	if cfg.TextChannel == "" {
		return "the voice channel's chat (" + cfg.Channel + ")"
	}
	return "#" + cfg.TextChannelName + " (" + cfg.TextChannel + ")"
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// RemoveDiscord drops discord.json and the token; it returns the paths it removed.
func RemoveDiscord() ([]string, error) {
	removed := []string{}
	for _, path := range []string{DiscordFile(), KeyPath(DiscordKey)} {
		debug.Log("voice", "discord off: rm %s", path)
		err := os.Remove(path)
		switch {
		case err == nil:
			removed = append(removed, path)
		case !os.IsNotExist(err):
			return removed, err
		}
	}
	return removed, nil
}
