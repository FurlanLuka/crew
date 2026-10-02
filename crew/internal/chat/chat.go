// Package chat keeps the plain Claude sessions Voice OS runs beside the worktrees: a folder and a
// name, nothing of crew's. Voice OS lists them with the worktrees (ref chat/<id>) and gives them no
// crew orientation. Data only.
package chat

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// Workspace is the ref's first half: chat/<id>. Reserved as a workspace name so it never collides.
const Workspace = "chat"

// Chat is one plain session.
type Chat struct {
	ID      string `json:"id"`
	Dir     string `json:"dir"`
	Name    string `json:"name"`
	Created string `json:"created"`
}

// Ref is how Voice OS and the developer name it.
func (c Chat) Ref() string { return Workspace + "/" + c.ID }

var validID = regexp.MustCompile(`^[0-9a-f]{6}$`)

// IsID: what chat rm takes, bare or as its ref.
func IsID(id string) bool { return validID.MatchString(id) }

// MaxName is the longest name a chat keeps; Voice OS says it aloud.
const MaxName = 60

func File() string { return filepath.Join(config.ConfigDir, "chats.json") }

// List reads chats.json; no file is no chats.
func List() ([]Chat, error) {
	data, err := os.ReadFile(File())
	if os.IsNotExist(err) {
		return []Chat{}, nil
	}
	if err != nil {
		return nil, err
	}
	chats := []Chat{}
	if err := json.Unmarshal(data, &chats); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", File(), err)
	}
	return chats, nil
}

// ResolveDir is the folder a chat runs in: home when none is given, else the path made absolute
// (~ is home). It must already exist and be a folder: crew never creates one for a chat.
func ResolveDir(dir, home string) (string, error) {
	dir = strings.TrimSpace(dir)
	switch {
	case dir == "" || dir == "~":
		dir = home
	case strings.HasPrefix(dir, "~/"):
		dir = filepath.Join(home, dir[2:])
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("no folder %s on this machine", abs)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is a file, not a folder", abs)
	}
	return abs, nil
}

// Add records a new chat in an existing folder and returns it.
func Add(dir, name string) (Chat, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Chat{}, err
	}
	resolved, err := ResolveDir(dir, home)
	if err != nil {
		return Chat{}, err
	}
	name = strings.TrimSpace(name)
	if len([]rune(name)) > MaxName {
		return Chat{}, fmt.Errorf("a name of at most %d characters", MaxName)
	}
	raw := make([]byte, 3)
	if _, err := rand.Read(raw); err != nil {
		return Chat{}, err
	}
	added := Chat{ID: hex.EncodeToString(raw), Dir: resolved, Name: name, Created: time.Now().UTC().Format(time.RFC3339)}
	err = update(func(chats []Chat) ([]Chat, error) {
		for _, c := range chats {
			if c.ID == added.ID {
				return nil, errors.New("that id is taken; run it again")
			}
		}
		return append(chats, added), nil
	})
	if err != nil {
		return Chat{}, err
	}
	debug.Log("chat", "added %s in %s", added.Ref(), added.Dir)
	return added, nil
}

// Remove drops a chat's record; its folder and its conversation are left as they are.
func Remove(id string) (Chat, error) {
	id = strings.TrimPrefix(id, Workspace+"/")
	if !IsID(id) {
		return Chat{}, fmt.Errorf("%q is not a chat (chat/<6 hex>)", id)
	}
	var removed Chat
	err := update(func(chats []Chat) ([]Chat, error) {
		kept := []Chat{}
		for _, c := range chats {
			if c.ID == id {
				removed = c
				continue
			}
			kept = append(kept, c)
		}
		if removed.ID == "" {
			return nil, fmt.Errorf("no chat %s (crew ls chats)", id)
		}
		return kept, nil
	})
	if err != nil {
		return Chat{}, err
	}
	debug.Log("chat", "removed %s", removed.Ref())
	return removed, nil
}

// update reads, changes and writes chats.json under a lock: the page and voice can add at once.
func update(change func([]Chat) ([]Chat, error)) error {
	if err := os.MkdirAll(config.ConfigDir, 0o755); err != nil {
		return err
	}
	lock, err := os.OpenFile(File()+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	chats, err := List()
	if err != nil {
		return err
	}
	next, err := change(chats)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	tmp := File() + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, File())
}
