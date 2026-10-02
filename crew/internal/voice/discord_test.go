package voice

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const goodToken = "bot-token-test"

// allPerms is View Channel | Connect | Speak.
const allPerms = "3146752"

type fakeDiscord struct {
	guilds   []discordGuild
	channels map[string][]discordChannel
	owners   map[string]string
	auth     []string
}

func (f *fakeDiscord) serve(t *testing.T) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") != "Bot "+goodToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/v10")
		switch {
		case path == "/users/@me":
			json.NewEncoder(w).Encode(map[string]string{"id": "900", "username": "crew"})
		case path == "/users/@me/guilds":
			json.NewEncoder(w).Encode(f.guilds)
		case strings.HasSuffix(path, "/channels"):
			id := strings.TrimSuffix(strings.TrimPrefix(path, "/guilds/"), "/channels")
			json.NewEncoder(w).Encode(f.channels[id])
		case strings.HasPrefix(path, "/guilds/"):
			id := strings.TrimPrefix(path, "/guilds/")
			json.NewEncoder(w).Encode(map[string]string{"id": id, "owner_id": f.owners[id]})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	saved := discordAPI
	discordAPI = srv.URL + "/api/v10"
	t.Cleanup(func() { discordAPI = saved })
}

func oneGuild() *fakeDiscord {
	return &fakeDiscord{
		guilds: []discordGuild{{ID: "155", Name: "Private", Permissions: allPerms}},
		channels: map[string][]discordChannel{"155": {
			{ID: "1", Name: "general", Type: 0},
			{ID: "2", Name: "General", Type: 2},
		}},
		owners: map[string]string{"155": "226"},
	}
}

func TestSetupDiscord_OneGuildOneChannel(t *testing.T) {
	keys := isolateKeys(t)
	f := oneGuild()
	f.serve(t)

	res, err := SetupDiscord("  "+goodToken+"\n", DiscordOptions{})
	if err != nil {
		t.Fatal(err)
	}

	want := DiscordConfig{Guild: "155", GuildName: "Private", Channel: "2", ChannelName: "General", Owner: "226"}
	if res.Config != want || res.OwnerGiven {
		t.Errorf("setup = %+v, want %+v", res, want)
	}
	data, err := os.ReadFile(filepath.Join(keys, "discord.key"))
	if err != nil || string(data) != goodToken+"\n" {
		t.Fatalf("key file %q (%v)", data, err)
	}
	if info, _ := os.Stat(filepath.Join(keys, "discord.key")); info.Mode().Perm() != 0o600 {
		t.Errorf("key mode %v, want 0600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(DiscordFile())
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]string
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	wantFields := map[string]string{"guild": "155", "channel": "2", "channel_name": "General", "guild_name": "Private", "owner": "226"}
	for k, v := range wantFields {
		if fields[k] != v {
			t.Errorf("discord.json %s = %q, want %q", k, fields[k], v)
		}
	}
	if len(fields) != len(wantFields) {
		t.Errorf("discord.json fields %v", fields)
	}
	for _, a := range f.auth {
		if a != "Bot "+goodToken {
			t.Errorf("Authorization %q", a)
		}
	}
}

func TestSetupDiscord_RejectedSavesNothing(t *testing.T) {
	keys := isolateKeys(t)
	oneGuild().serve(t)

	_, err := SetupDiscord("wrong", DiscordOptions{})

	if !errors.Is(err, ErrDiscordRejected) {
		t.Fatalf("err = %v, want rejected", err)
	}
	if _, err := os.Stat(filepath.Join(keys, "discord.key")); !os.IsNotExist(err) {
		t.Error("a rejected token was saved")
	}
	if _, err := os.Stat(DiscordFile()); !os.IsNotExist(err) {
		t.Error("discord.json written for a rejected token")
	}
}

func TestSetupDiscord_KeyNotAskedOnFirstStart(t *testing.T) {
	isolateKeys(t)
	if IsKeyName(DiscordKey) {
		t.Error("discord is one of KeyNames: the first crew server would ask for it")
	}
}

func twoGuilds() *fakeDiscord {
	f := oneGuild()
	f.guilds = append(f.guilds, discordGuild{ID: "377", Name: "Work", Permissions: allPerms})
	f.channels["377"] = []discordChannel{{ID: "7", Name: "Standup", Type: 2}}
	f.owners["377"] = "500"
	return f
}

func TestSetupDiscord_SeveralGuildsNeedGuild(t *testing.T) {
	isolateKeys(t)
	twoGuilds().serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{})

	if err == nil || !strings.Contains(err.Error(), "--guild") ||
		!strings.Contains(err.Error(), "155\tPrivate") || !strings.Contains(err.Error(), "377\tWork") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(DiscordFile()); !os.IsNotExist(err) {
		t.Error("discord.json written without a server")
	}
	if got := SavedDiscordToken(); got != goodToken {
		t.Errorf("saved token %q: a rerun with --guild would need a paste", got)
	}
}

func TestSetupDiscord_GuildPicks(t *testing.T) {
	isolateKeys(t)
	twoGuilds().serve(t)

	res, err := SetupDiscord(goodToken, DiscordOptions{Guild: "377"})

	if err != nil {
		t.Fatal(err)
	}
	if res.Config.Guild != "377" || res.Config.Channel != "7" || res.Config.Owner != "500" {
		t.Errorf("config %+v", res.Config)
	}
}

func TestSetupDiscord_NoGuild(t *testing.T) {
	isolateKeys(t)
	f := oneGuild()
	f.guilds = []discordGuild{}
	f.serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{})

	if err == nil || !strings.Contains(err.Error(), "invite") {
		t.Fatalf("err = %v", err)
	}
}

func TestSetupDiscord_VoiceOSChannelPreferred(t *testing.T) {
	isolateKeys(t)
	f := oneGuild()
	f.channels["155"] = append(f.channels["155"], discordChannel{ID: "3", Name: "voice os", Type: 2})
	f.serve(t)

	res, err := SetupDiscord(goodToken, DiscordOptions{})

	if err != nil {
		t.Fatal(err)
	}
	if res.Config.Channel != "3" || res.Config.ChannelName != "voice os" {
		t.Errorf("channel %s (%s), want voice os (3)", res.Config.ChannelName, res.Config.Channel)
	}
}

func severalChannels() *fakeDiscord {
	f := oneGuild()
	f.channels["155"] = append(f.channels["155"], discordChannel{ID: "4", Name: "Gaming", Type: 2})
	return f
}

func TestSetupDiscord_SeveralChannelsNeedChannel(t *testing.T) {
	isolateKeys(t)
	severalChannels().serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{})

	if err == nil || !strings.Contains(err.Error(), "--channel") ||
		!strings.Contains(err.Error(), "2\tGeneral") || !strings.Contains(err.Error(), "4\tGaming") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "1\tgeneral") {
		t.Error("a text channel was offered")
	}
}

func TestSetupDiscord_ChannelByNameAndID(t *testing.T) {
	isolateKeys(t)
	severalChannels().serve(t)

	for _, want := range []string{"gaming", "4"} {
		res, err := SetupDiscord(goodToken, DiscordOptions{Channel: want})
		if err != nil {
			t.Fatalf("--channel=%s: %v", want, err)
		}
		if res.Config.Channel != "4" || res.Config.ChannelName != "Gaming" {
			t.Errorf("--channel=%s picked %+v", want, res.Config)
		}
	}
	if _, err := SetupDiscord(goodToken, DiscordOptions{Channel: "1"}); err == nil {
		t.Error("--channel picked a text channel")
	}
}

func TestSetupDiscord_UserOverridesOwner(t *testing.T) {
	isolateKeys(t)
	oneGuild().serve(t)

	res, err := SetupDiscord(goodToken, DiscordOptions{User: "777"})

	if err != nil {
		t.Fatal(err)
	}
	if res.Config.Owner != "777" || !res.OwnerGiven {
		t.Errorf("owner %q given %v", res.Config.Owner, res.OwnerGiven)
	}
}

func TestSetupDiscord_MissingSpeak(t *testing.T) {
	isolateKeys(t)
	f := oneGuild()
	f.guilds[0].Permissions = "1049600" // View Channel | Connect
	f.serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{})

	if err == nil || !strings.Contains(err.Error(), "Speak") || strings.Contains(err.Error(), "lacks Connect") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(DiscordFile()); !os.IsNotExist(err) {
		t.Error("discord.json written for a bot that cannot speak")
	}
}

func TestSetupDiscord_AdministratorPasses(t *testing.T) {
	isolateKeys(t)
	f := oneGuild()
	f.guilds[0].Permissions = "8"
	f.serve(t)

	if _, err := SetupDiscord(goodToken, DiscordOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestDiscordStatusRows_NotSetUp(t *testing.T) {
	isolateKeys(t)

	report, err := InspectDiscord()
	if err != nil {
		t.Fatal(err)
	}

	got := DiscordStatusRows(report)
	want := [][2]string{
		{"setup", "not set up (crew server discord setup)"},
		{"token", "missing"},
		{"live", "Voice OS has not reported"},
	}
	if !equalRows(got, want) {
		t.Errorf("rows\n%v\nwant\n%v", got, want)
	}
}

func TestDiscordStatusRows_SetUpAndReported(t *testing.T) {
	isolateKeys(t)
	oneGuild().serve(t)
	if _, err := SetupDiscord(goodToken, DiscordOptions{}); err != nil {
		t.Fatal(err)
	}
	live := `{"connected":true,"owner_in_channel":false,"error":"","at":"2026-10-01T10:00:00Z"}`
	if err := os.WriteFile(DiscordStatusFile(), []byte(live), 0o600); err != nil {
		t.Fatal(err)
	}

	report, err := InspectDiscord()
	if err != nil {
		t.Fatal(err)
	}

	want := [][2]string{
		{"setup", "ready"},
		{"token", "set"},
		{"server", "Private (155)"},
		{"channel", "General (2)"},
		{"messages", "the voice channel's chat (2)"},
		{"owner", "226"},
		{"connected", "yes"},
		{"owner_in_channel", "no"},
		{"at", "2026-10-01T10:00:00Z"},
	}
	if got := DiscordStatusRows(report); !equalRows(got, want) {
		t.Errorf("rows\n%v\nwant\n%v", got, want)
	}

	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"set_up":true,"token":true,"config":{"guild":"155","channel":"2","channel_name":"General","guild_name":"Private","owner":"226"},"live":{"connected":true,"owner_in_channel":false,"error":"","at":"2026-10-01T10:00:00Z"}}`
	if string(data) != wantJSON {
		t.Errorf("json\n%s\nwant\n%s", data, wantJSON)
	}
}

func TestDiscordReport_JSONWithNothing(t *testing.T) {
	isolateKeys(t)

	report, err := InspectDiscord()
	if err != nil {
		t.Fatal(err)
	}

	data, _ := json.Marshal(report)
	if string(data) != `{"set_up":false,"token":false,"config":null,"live":null}` {
		t.Errorf("json %s", data)
	}
}

func TestRemoveDiscord(t *testing.T) {
	keys := isolateKeys(t)
	oneGuild().serve(t)
	if _, err := SetupDiscord(goodToken, DiscordOptions{}); err != nil {
		t.Fatal(err)
	}

	removed, err := RemoveDiscord()

	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 2 || removed[0] != DiscordFile() || removed[1] != filepath.Join(keys, "discord.key") {
		t.Errorf("removed %v", removed)
	}
	again, err := RemoveDiscord()
	if err != nil || len(again) != 0 {
		t.Errorf("second off: %v %v", again, err)
	}
}

func equalRows(a, b [][2]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSetupDiscord_UnknownGuildListsGuilds(t *testing.T) {
	isolateKeys(t)
	twoGuilds().serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{Guild: "999"})

	if err == nil || !strings.Contains(err.Error(), "999") ||
		!strings.Contains(err.Error(), "155\tPrivate") || !strings.Contains(err.Error(), "377\tWork") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(DiscordFile()); !os.IsNotExist(err) {
		t.Error("discord.json written for an unknown server")
	}
}

func TestSetupDiscord_OnlyTextChannels(t *testing.T) {
	isolateKeys(t)
	f := oneGuild()
	f.channels["155"] = []discordChannel{{ID: "1", Name: "general", Type: 0}}
	f.serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{})

	if err == nil || !strings.Contains(err.Error(), "Private has no voice channel") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(DiscordFile()); !os.IsNotExist(err) {
		t.Error("discord.json written for a server with no voice channel")
	}
}

func TestSetupDiscord_UnparseablePermissionsNameAll(t *testing.T) {
	isolateKeys(t)
	f := oneGuild()
	f.guilds[0].Permissions = "not-a-number"
	f.serve(t)

	_, err := SetupDiscord(goodToken, DiscordOptions{})

	if err == nil {
		t.Fatal("setup passed with unreadable permissions")
	}
	if !strings.Contains(err.Error(), "lacks View Channel, Connect, Speak on Private") {
		t.Fatalf("err = %v, want all three permissions named", err)
	}
	if _, err := os.Stat(DiscordFile()); !os.IsNotExist(err) {
		t.Error("discord.json written with unreadable permissions")
	}
}

func TestSetupDiscord_ServerErrorIsNotRejection(t *testing.T) {
	keys := isolateKeys(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	saved := discordAPI
	discordAPI = srv.URL + "/api/v10"
	t.Cleanup(func() { discordAPI = saved })

	_, err := SetupDiscord(goodToken, DiscordOptions{})

	if err == nil || errors.Is(err, ErrDiscordRejected) || !strings.Contains(err.Error(), "500") {
		t.Fatalf("err = %v, want a 500 that is not a rejection", err)
	}
	if _, err := os.Stat(filepath.Join(keys, "discord.key")); !os.IsNotExist(err) {
		t.Error("a token Discord never checked was saved")
	}
}

// discordFiles is the contract shared with Voice OS:
// voiceos/src/discord reads the same fixture.
func discordFiles(t *testing.T) (config, status json.RawMessage) {
	t.Helper()
	data, err := os.ReadFile("../../../voiceos/test/fixtures/shared/discord-files.json")
	if err != nil {
		t.Fatal(err)
	}
	var files struct {
		Config json.RawMessage `json:"config"`
		Status json.RawMessage `json:"status"`
	}
	if err := json.Unmarshal(data, &files); err != nil {
		t.Fatal(err)
	}
	return files.Config, files.Status
}

func TestDiscordConfig_SharedFixtureRoundTrips(t *testing.T) {
	raw, _ := discordFiles(t)
	var cfg DiscordConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}

	out, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}

	var want, got map[string]any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("round trip\n%v\nwant\n%v", got, want)
	}
}

func TestInspectDiscord_SharedFixtureStatus(t *testing.T) {
	isolateKeys(t)
	config, status := discordFiles(t)
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(DiscordFile(), config, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(DiscordStatusFile(), status, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveKey(DiscordKey, goodToken); err != nil {
		t.Fatal(err)
	}

	report, err := InspectDiscord()
	if err != nil {
		t.Fatal(err)
	}

	wantLive := DiscordLive{Connected: true, OwnerInChannel: true, Error: "", At: "2026-10-01T10:00:00.000Z"}
	if report.Live == nil || *report.Live != wantLive {
		t.Fatalf("live %+v, want %+v", report.Live, wantLive)
	}
	want := [][2]string{
		{"setup", "ready"},
		{"token", "set"},
		{"server", "Home (1001)"},
		{"channel", "Voice OS (2002)"},
		{"messages", "the voice channel's chat (2002)"},
		{"owner", "3003"},
		{"connected", "yes"},
		{"owner_in_channel", "yes"},
		{"at", "2026-10-01T10:00:00.000Z"},
	}
	if got := DiscordStatusRows(report); !equalRows(got, want) {
		t.Errorf("rows\n%v\nwant\n%v", got, want)
	}
}
