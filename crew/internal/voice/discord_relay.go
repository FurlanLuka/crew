package voice

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// A remote has no Discord token: it stages its message, the main fetches the stage over scp (the
// main reaches every remote) and posts it. A remote names only the stage's id, never a path.
var discordStageID = regexp.MustCompile(`^[0-9a-f]{16}$`)

// IsDiscordStageID is what the main accepts as a stage to fetch.
func IsDiscordStageID(id string) bool { return discordStageID.MatchString(id) }

// DiscordStageDir is where this machine stages a message for the main.
func DiscordStageDir(id string) string { return filepath.Join(config.ConfigDir, "discord-out", id) }

// The same stage seen from the main's scp: relative to the remote's home.
func remoteDiscordStageDir(id string) string { return ".crew/discord-out/" + id }

const stageManifest = "message.json"

// fetchDiscordStage copies a remote's stage into a local parent directory; a var so tests fake scp.
var fetchDiscordStage = func(host, dir, parent string) error {
	args := append(scpOptions(), "-r", host+":"+dir, parent+"/")
	debug.Log("voice", "discord send: scp ← %s:%s", host, dir)
	out, err := osexec.Command("scp", args...).CombinedOutput()
	return describeRunError(out, err)
}

// The manifest keeps the text and each file's own name: files sit in numbered folders, so two named
// alike never collide and each keeps its name in Discord.
type stagedMessage struct {
	Text  string   `json:"text"`
	Files []string `json:"files"`
}

// StageDiscordMessage copies a message into a new stage and returns its id. The limits are checked
// first, so a message the main would refuse never travels.
func StageDiscordMessage(msg DiscordMessage) (id string, err error) {
	if err := CheckDiscordLimits(msg); err != nil {
		return "", err
	}
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	id = hex.EncodeToString(raw)
	dir := DiscordStageDir(id)
	// A stage that failed halfway is never left behind.
	defer func() {
		if err != nil {
			os.RemoveAll(dir)
		}
	}()
	manifest := stagedMessage{Text: msg.Text, Files: []string{}}
	for i, path := range msg.Files {
		name := filepath.Base(path)
		into := filepath.Join(dir, fmt.Sprint(i))
		if err := os.MkdirAll(into, 0o700); err != nil {
			return "", err
		}
		if err := copyFile(path, filepath.Join(into, name)); err != nil {
			return "", err
		}
		manifest.Files = append(manifest.Files, filepath.Join(fmt.Sprint(i), name))
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, stageManifest), data, 0o600); err != nil {
		return "", err
	}
	debug.Log("voice", "discord send: staged %s (%d files)", id, len(manifest.Files))
	return id, nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return fmt.Errorf("cannot read %s: %w", from, err)
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// readStagedMessage reads a stage back as a message. Paths come from the manifest, so each is kept
// inside the stage: a manifest naming anything else is refused.
func readStagedMessage(dir string) (DiscordMessage, error) {
	data, err := os.ReadFile(filepath.Join(dir, stageManifest))
	if err != nil {
		return DiscordMessage{}, fmt.Errorf("the staged message is gone: %w", err)
	}
	var staged stagedMessage
	if err := json.Unmarshal(data, &staged); err != nil {
		return DiscordMessage{}, fmt.Errorf("the staged message is unreadable: %w", err)
	}
	msg := DiscordMessage{Text: staged.Text}
	for _, rel := range staged.Files {
		clean := filepath.Clean(rel)
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return DiscordMessage{}, fmt.Errorf("the staged message names a file outside it: %s", rel)
		}
		path := filepath.Join(dir, clean)
		// Only files the stage holds itself: a link out of it could name the main's own token.
		if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
			return DiscordMessage{}, fmt.Errorf("the staged message's %s is not a plain file", rel)
		}
		msg.Files = append(msg.Files, path)
	}
	return msg, nil
}

// SendStagedDiscord posts a staged message on the main: this machine's own stage, or a remote's
// fetched over scp first. Every copy is removed once it is sent or refused.
func SendStagedDiscord(id, source string) (DiscordSent, error) {
	if !IsDiscordStageID(id) {
		return DiscordSent{}, fmt.Errorf("not a staged message: %q", id)
	}
	dir := DiscordStageDir(id)
	if source != "" && source != MainID {
		host, err := machineHost(source)
		if err != nil {
			return DiscordSent{}, err
		}
		parent, err := os.MkdirTemp("", "crew-discord-")
		if err != nil {
			return DiscordSent{}, err
		}
		defer os.RemoveAll(parent)
		// The remote removes its own stage once the main answers.
		if err := fetchDiscordStage(host, remoteDiscordStageDir(id), parent); err != nil {
			return DiscordSent{}, fmt.Errorf("fetching the message from %s: %w", source, err)
		}
		dir = filepath.Join(parent, id)
	} else {
		defer os.RemoveAll(dir)
	}
	msg, err := readStagedMessage(dir)
	if err != nil {
		return DiscordSent{}, err
	}
	return SendDiscord(msg)
}

func machineHost(id string) (string, error) {
	machines, err := ReadMachines()
	if err != nil {
		return "", err
	}
	for _, m := range machines {
		if m.ID == id {
			return m.Host, nil
		}
	}
	return "", errors.New("no machine " + id + " in machines.json")
}

// discordReadyWait bounds the remote's question at a session's start (with the 2 s dial, about 5 s at
// worst): no answer, no Discord line.
var discordReadyWait = 3 * time.Second

// DiscordSendWait is how long a remote waits for the main to fetch and post its message: past the
// main's own 150 s for running crew and its daemon's 160 s (query-allow.ts).
const DiscordSendWait = 170 * time.Second

// discordRole is this machine's role; a var so tests never ask a real main through a real daemon.
var discordRole = func() Role { return CurrentRole(false) }

// DiscordSendQuery and DiscordStatusQuery are what a remote asks the main;
// voiceos/test/fixtures/shared/discord-send.json pins them with the main's allowlist (query-allow.ts).
func DiscordSendQuery(id string, json bool) []string {
	argv := []string{"voice", "discord", "_send", id}
	if json {
		argv = append(argv, "--json")
	}
	return argv
}

func DiscordStatusQuery() []string { return []string{"voice", "discord", "status", "--json"} }

// askMainForDiscord is the remote's question to the main; a var for the same reason.
var askMainForDiscord = func() (QueryReply, error) {
	return AskMainWithin(RemoteQuerySocket(), DiscordStatusQuery(), discordReadyWait)
}

// DiscordSendReady says whether crew server discord send would post: set up here, or — on a remote,
// which never holds the token — on the main, asked through the daemon's link.
func DiscordSendReady() bool {
	if discordRole() != RoleRemote {
		report, err := InspectDiscord()
		return err == nil && report.SetUp
	}
	reply, err := askMainForDiscord()
	if err != nil || !reply.OK || reply.Value == nil || reply.Value.Code != 0 {
		return false
	}
	var report DiscordReport
	return json.Unmarshal([]byte(reply.Value.Stdout), &report) == nil && report.SetUp
}
