package voice

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// postPerms is View Channel | Connect | Speak | Send Messages | Attach Files.
const postPerms = "3181568"

func setUpDiscord(t *testing.T, cfg DiscordConfig) {
	t.Helper()
	isolateKeys(t)
	if err := SaveKey(DiscordKey, goodToken); err != nil {
		t.Fatal(err)
	}
	if err := writeDiscordConfig(cfg); err != nil {
		t.Fatal(err)
	}
}

var homeServer = DiscordConfig{Guild: "155", GuildName: "Private", Channel: "2", ChannelName: "General", Owner: "226"}

type postedMessage struct {
	channel string
	payload map[string]any
	files   map[string]string
}

// fakePost answers message posts: status codes in turn (the last one repeats), each post recorded.
func fakePost(t *testing.T, codes ...int) *[]postedMessage {
	t.Helper()
	posted := &[]postedMessage{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bot "+goodToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/v10")
		channel := strings.TrimSuffix(strings.TrimPrefix(path, "/channels/"), "/messages")
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Errorf("not multipart: %v", err)
		}
		msg := postedMessage{channel: channel, files: map[string]string{}}
		json.Unmarshal([]byte(r.FormValue("payload_json")), &msg.payload)
		for field, headers := range r.MultipartForm.File {
			f, _ := headers[0].Open()
			data, _ := io.ReadAll(f)
			msg.files[field+"="+headers[0].Filename] = string(data)
		}
		*posted = append(*posted, msg)
		code := codes[min(len(*posted)-1, len(codes)-1)]
		w.WriteHeader(code)
		if code == http.StatusTooManyRequests {
			w.Write([]byte(`{"retry_after": 0.01}`))
			return
		}
		w.Write([]byte(`{"id": "777"}`))
	}))
	t.Cleanup(srv.Close)
	saved := discordAPI
	discordAPI = srv.URL + "/api/v10"
	t.Cleanup(func() { discordAPI = saved })
	return posted
}

func writeTemp(t *testing.T, name string, size int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(strings.Repeat("x", size)), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSendDiscord_TextAndFilesToTheVoiceChat(t *testing.T) {
	setUpDiscord(t, homeServer)
	posted := fakePost(t, http.StatusOK)
	shot := writeTemp(t, "shot.png", 10)

	sent, err := SendDiscord(DiscordMessage{Text: " The retry fix is in. @everyone ", Files: []string{shot}})
	if err != nil {
		t.Fatal(err)
	}

	want := DiscordSent{Channel: "2", ChannelName: "General", Message: "777", Link: "https://discord.com/channels/155/2/777", Files: 1, IsVoiceChat: true}
	if sent != want {
		t.Errorf("sent = %+v, want %+v", sent, want)
	}
	if len(*posted) != 1 {
		t.Fatalf("posted %d times", len(*posted))
	}
	got := (*posted)[0]
	if got.channel != "2" || got.payload["content"] != "The retry fix is in. @everyone" {
		t.Errorf("posted %+v", got)
	}
	if mentions, _ := got.payload["allowed_mentions"].(map[string]any); len(mentions["parse"].([]any)) != 0 {
		t.Errorf("mentions may ping: %v", got.payload["allowed_mentions"])
	}
	if got.files["files[0]=shot.png"] != "xxxxxxxxxx" {
		t.Errorf("files %v", got.files)
	}
}

func TestSendDiscord_PickedTextChannel(t *testing.T) {
	cfg := homeServer
	cfg.TextChannel, cfg.TextChannelName = "1", "general"
	setUpDiscord(t, cfg)
	posted := fakePost(t, http.StatusOK)

	sent, err := SendDiscord(DiscordMessage{Text: "hi"})

	if err != nil || sent.Channel != "1" || sent.IsVoiceChat || (*posted)[0].channel != "1" {
		t.Fatalf("sent %+v (%v), posted %+v", sent, err, *posted)
	}
}

func TestSendDiscord_LongTextGoesAsAFile(t *testing.T) {
	setUpDiscord(t, homeServer)
	posted := fakePost(t, http.StatusOK)
	long := strings.Repeat("a", MaxDiscordText+1)

	sent, err := SendDiscord(DiscordMessage{Text: long})

	if err != nil || !sent.TextAttached {
		t.Fatalf("sent %+v (%v)", sent, err)
	}
	got := (*posted)[0]
	if _, has := got.payload["content"]; has || got.files["files[0]=message.md"] != long+"\n" {
		t.Errorf("posted %+v", got.payload)
	}
}

func TestSendDiscord_LimitsCheckedBeforeAnythingIsSent(t *testing.T) {
	setUpDiscord(t, homeServer)
	posted := fakePost(t, http.StatusOK)
	small := writeTemp(t, "a.txt", 1)
	tooMany := make([]string, MaxDiscordFiles+1)
	for i := range tooMany {
		tooMany[i] = small
	}

	cases := map[string]DiscordMessage{
		"nothing":   {Text: "  "},
		"too big":   {Files: []string{writeTemp(t, "big.bin", MaxDiscordFile+1)}},
		"too many":  {Files: tooMany},
		"long+ten":  {Text: strings.Repeat("a", MaxDiscordText+1), Files: tooMany[:MaxDiscordFiles]},
		"missing":   {Files: []string{filepath.Join(t.TempDir(), "gone.png")}},
		"directory": {Files: []string{t.TempDir()}},
	}
	for name, msg := range cases {
		if _, err := SendDiscord(msg); err == nil {
			t.Errorf("%s: sent", name)
		}
	}
	if len(*posted) != 0 {
		t.Errorf("posted %d times", len(*posted))
	}
}

func TestSendDiscord_RateLimitedOnceThenSent(t *testing.T) {
	setUpDiscord(t, homeServer)
	saved := discordRetryWait
	discordRetryWait = 50 * time.Millisecond
	t.Cleanup(func() { discordRetryWait = saved })
	posted := fakePost(t, http.StatusTooManyRequests, http.StatusOK)

	if _, err := SendDiscord(DiscordMessage{Text: "hi"}); err != nil || len(*posted) != 2 {
		t.Fatalf("err %v after %d posts", err, len(*posted))
	}
}

func TestSendDiscord_RefusalsSaySo(t *testing.T) {
	for code, want := range map[int]string{
		http.StatusForbidden:       "Send Messages and Attach Files",
		http.StatusTooManyRequests: "429",
		http.StatusBadGateway:      "502",
	} {
		setUpDiscord(t, homeServer)
		saved := discordRetryWait
		discordRetryWait = time.Millisecond
		fakePost(t, code)

		_, err := SendDiscord(DiscordMessage{Text: "hi"})
		discordRetryWait = saved

		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%d: err = %v", code, err)
		}
	}
}

func TestSendDiscord_NotSetUp(t *testing.T) {
	isolateKeys(t)

	if _, err := SendDiscord(DiscordMessage{Text: "hi"}); err != ErrDiscordNotSetUp {
		t.Errorf("err = %v", err)
	}
}

func TestSetupDiscord_TextChannelPickedKeptAndCleared(t *testing.T) {
	isolateKeys(t)
	f := oneGuild()
	f.guilds[0].Permissions = postPerms
	f.serve(t)

	picked, err := SetupDiscord(goodToken, DiscordOptions{TextChannel: "#general"})
	if err != nil || picked.Config.TextChannel != "1" || picked.Config.TextChannelName != "general" {
		t.Fatalf("picked %+v (%v)", picked.Config, err)
	}
	kept, err := SetupDiscord(goodToken, DiscordOptions{})
	if err != nil || kept.Config.TextChannel != "1" {
		t.Fatalf("a rerun moved the messages: %+v (%v)", kept.Config, err)
	}
	cleared, err := SetupDiscord(goodToken, DiscordOptions{TextChannel: "voice"})
	if err != nil || cleared.Config.TextChannel != "" {
		t.Fatalf("voice kept %+v (%v)", cleared.Config, err)
	}
	if _, err := SetupDiscord(goodToken, DiscordOptions{TextChannel: "nowhere"}); err == nil ||
		!strings.Contains(err.Error(), "1\tgeneral") {
		t.Errorf("an unknown channel: %v", err)
	}
}

func TestSetupDiscord_TextChannelNeedsPostPermissions(t *testing.T) {
	isolateKeys(t)
	oneGuild().serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{TextChannel: "general"})

	if err == nil || !strings.Contains(err.Error(), "Send Messages, Attach Files") {
		t.Errorf("err = %v", err)
	}
}

func TestMessageChannels_TextAnnouncementAndVoiceByName(t *testing.T) {
	got := MessageChannels([]discordChannel{
		{ID: "9", Name: "zeta", Type: discordTextChannel},
		{ID: "3", Name: "category", Type: 4},
		{ID: "2", Name: "General", Type: discordVoiceChannel},
		{ID: "5", Name: "news", Type: discordAnnouncementChannel},
	})

	var ids []string
	for _, c := range got {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "2,5,9" {
		t.Errorf("channels %v", ids)
	}
}
