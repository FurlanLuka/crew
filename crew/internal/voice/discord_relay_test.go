package voice

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRemote stands in for scp from a remote whose home is a temp dir.
func fakeRemote(t *testing.T) (home string, ran *[]string) {
	t.Helper()
	home = t.TempDir()
	ran = &[]string{}
	saved := fetchDiscordStage
	fetchDiscordStage = func(host, dir, parent string) error {
		*ran = append(*ran, host+": scp "+dir)
		return copyTree(filepath.Join(home, dir), filepath.Join(parent, filepath.Base(dir)))
	}
	t.Cleanup(func() { fetchDiscordStage = saved })
	return home, ran
}

func copyTree(from, to string) error {
	return filepath.Walk(from, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		target := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
}

func TestStageThenSend_ARemotesMessageReachesDiscordWhole(t *testing.T) {
	setUpDiscord(t, homeServer)
	posted := fakePost(t, http.StatusOK)
	if _, err := AddMachine("dev@vm1.example.com", "Build box"); err != nil {
		t.Fatal(err)
	}
	machines, _ := ReadMachines()
	source := machines[0].ID
	home, ran := fakeRemote(t)

	// Staged on "the remote": two files with the same name stay apart and keep their names.
	first, second := writeTemp(t, "shot.png", 3), writeTemp(t, "shot.png", 4)
	id, err := StageDiscordMessage(DiscordMessage{Text: "Here it is.", Files: []string{first, second}})
	if err != nil || !IsDiscordStageID(id) {
		t.Fatalf("staged %q (%v)", id, err)
	}
	if err := copyTree(DiscordStageDir(id), filepath.Join(home, remoteDiscordStageDir(id))); err != nil {
		t.Fatal(err)
	}

	sent, err := SendStagedDiscord(id, source)
	if err != nil || sent.Message != "777" {
		t.Fatalf("sent %+v (%v)", sent, err)
	}
	got := (*posted)[0]
	if got.payload["content"] != "Here it is." || got.files["files[0]=shot.png"] != "xxx" || got.files["files[1]=shot.png"] != "xxxx" {
		t.Errorf("posted %+v %v", got.payload, got.files)
	}
	// One scp, nothing else over SSH: the remote removes its own stage once the main answers.
	if len(*ran) != 1 || !strings.Contains((*ran)[0], id) {
		t.Errorf("ssh %v", *ran)
	}
}

func TestSendStagedDiscord_OwnStageIsSentAndRemoved(t *testing.T) {
	setUpDiscord(t, homeServer)
	fakePost(t, http.StatusOK)
	id, err := StageDiscordMessage(DiscordMessage{Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := SendStagedDiscord(id, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(DiscordStageDir(id)); !os.IsNotExist(err) {
		t.Errorf("the stage is still there: %v", err)
	}
}

func TestSendStagedDiscord_RefusesWhatIsNotAStage(t *testing.T) {
	setUpDiscord(t, homeServer)
	posted := fakePost(t, http.StatusOK)

	for _, id := range []string{"../../etc", "ABCDEF0123456789", "short"} {
		if _, err := SendStagedDiscord(id, ""); err == nil {
			t.Errorf("%q was sent", id)
		}
	}
	if _, err := SendStagedDiscord("0123456789abcdef", "nowhere"); err == nil {
		t.Error("an unknown machine was asked")
	}
	if len(*posted) != 0 {
		t.Errorf("posted %d", len(*posted))
	}
}

func TestReadStagedMessage_AFileOutsideTheStageIsRefused(t *testing.T) {
	dir := t.TempDir()
	for _, manifest := range []string{
		`{"text":"x","files":["../secret"]}`,
		`{"text":"x","files":["/etc/passwd"]}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, stageManifest), []byte(manifest), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := readStagedMessage(dir); err == nil {
			t.Errorf("%s was read", manifest)
		}
	}
}

func TestStageDiscordMessage_LimitsCheckedBeforeStaging(t *testing.T) {
	isolateKeys(t)

	if _, err := StageDiscordMessage(DiscordMessage{Files: []string{writeTemp(t, "big.bin", MaxDiscordFile+1)}}); err == nil {
		t.Fatal("a file too big was staged")
	}
	entries, _ := os.ReadDir(filepath.Dir(DiscordStageDir("x")))
	if len(entries) != 0 {
		t.Errorf("staged %d", len(entries))
	}
}

func asRole(t *testing.T, role Role) {
	t.Helper()
	saved := discordRole
	discordRole = func() Role { return role }
	t.Cleanup(func() { discordRole = saved })
}

func TestDiscordSendReady_OnTheMainItIsTheSetup(t *testing.T) {
	isolateKeys(t)
	asRole(t, RoleMain)
	if DiscordSendReady() {
		t.Error("ready with nothing set up")
	}
	setUpDiscord(t, homeServer)
	if !DiscordSendReady() {
		t.Error("not ready when set up")
	}
}

func TestDiscordSendReady_OnARemoteTheMainSays(t *testing.T) {
	isolateKeys(t)
	asRole(t, RoleRemote)
	saved := askMainForDiscord
	t.Cleanup(func() { askMainForDiscord = saved })
	answer := func(reply QueryReply, err error) bool {
		askMainForDiscord = func() (QueryReply, error) { return reply, err }
		return DiscordSendReady()
	}
	ok := func(stdout string) QueryReply {
		return QueryReply{OK: true, Value: &QueryValue{Code: 0, Stdout: stdout}}
	}

	if !answer(ok(`{"set_up":true,"token":true}`), nil) {
		t.Error("the main set up: not ready")
	}
	for name, ready := range map[string]bool{
		"not set up": answer(ok(`{"set_up":false}`), nil),
		"no main":    answer(QueryReply{}, ErrNoQuerySocket),
		"timeout":    answer(QueryReply{Reason: "timeout"}, nil),
		"failed":     answer(QueryReply{OK: true, Value: &QueryValue{Code: 1}}, nil),
		"unreadable": answer(ok("nope"), nil),
	} {
		if ready {
			t.Errorf("%s: ready", name)
		}
	}
}

func TestSendStagedDiscord_ARefusedSendStillRemovesItsStage(t *testing.T) {
	setUpDiscord(t, homeServer)
	fakePost(t, http.StatusForbidden)
	id, err := StageDiscordMessage(DiscordMessage{Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := SendStagedDiscord(id, ""); err == nil {
		t.Fatal("sent")
	}
	if _, err := os.Stat(DiscordStageDir(id)); !os.IsNotExist(err) {
		t.Errorf("the stage is still there: %v", err)
	}
}

func TestReadStagedMessage_ALinkOutOfTheStageIsRefused(t *testing.T) {
	dir := t.TempDir()
	secret := writeTemp(t, "discord.key", 5)
	if err := os.MkdirAll(filepath.Join(dir, "0"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(dir, "0", "x.png")); err != nil {
		t.Fatal(err)
	}
	manifest := `{"text":"x","files":["0/x.png"]}`
	if err := os.WriteFile(filepath.Join(dir, stageManifest), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := readStagedMessage(dir); err == nil || !strings.Contains(err.Error(), "not a plain file") {
		t.Errorf("err = %v", err)
	}
}
