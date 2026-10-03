package chat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func isolate(t *testing.T) string {
	t.Helper()
	saved := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = saved })
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func TestAddListRemove(t *testing.T) {
	home := isolate(t)
	notes := filepath.Join(home, "notes")
	if err := os.Mkdir(notes, 0o755); err != nil {
		t.Fatal(err)
	}

	inHome, err := Add("", "  research ")
	if err != nil || inHome.Dir != home || inHome.Name != "research" || !IsID(inHome.ID) || inHome.Created == "" {
		t.Fatalf("added %+v (%v)", inHome, err)
	}
	inNotes, err := Add("~/notes", "")
	if err != nil || inNotes.Dir != notes {
		t.Fatalf("added %+v (%v)", inNotes, err)
	}

	chats, err := List()
	if err != nil || len(chats) != 2 || chats[0].Ref() != "chat/"+inHome.ID {
		t.Fatalf("listed %+v (%v)", chats, err)
	}

	removed, err := Remove("chat/" + inHome.ID)
	if err != nil || removed.ID != inHome.ID {
		t.Fatalf("removed %+v (%v)", removed, err)
	}
	if chats, _ := List(); len(chats) != 1 || chats[0].ID != inNotes.ID {
		t.Errorf("left %+v", chats)
	}
	if _, err := os.Stat(home); err != nil {
		t.Error("the folder went with the record")
	}
}

func TestAdd_RefusesWhatIsNotAFolderHere(t *testing.T) {
	home := isolate(t)
	file := filepath.Join(home, "a.txt")
	os.WriteFile(file, []byte("x"), 0o600)

	for dir, want := range map[string]string{
		filepath.Join(home, "missing"): "no folder",
		file:                           "is a file",
	} {
		if _, err := Add(dir, ""); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", dir, err)
		}
	}
	if _, err := Add("", strings.Repeat("n", MaxName+1)); err == nil {
		t.Error("a name too long was kept")
	}
	if chats, _ := List(); len(chats) != 0 {
		t.Errorf("recorded %+v", chats)
	}
	if _, err := os.Stat(filepath.Join(home, "missing")); !os.IsNotExist(err) {
		t.Error("a folder was created")
	}
}

func TestRemove_UnknownOrMalformed(t *testing.T) {
	isolate(t)
	for _, id := range []string{"abc123", "chat/zzzzzz", "../x"} {
		if _, err := Remove(id); err == nil {
			t.Errorf("%q removed", id)
		}
	}
}

func TestList_NoFileIsNoChats(t *testing.T) {
	isolate(t)
	if chats, err := List(); err != nil || chats == nil || len(chats) != 0 {
		t.Errorf("%v %v", chats, err)
	}
}

func TestAdd_ConcurrentAddsAllKept(t *testing.T) {
	isolate(t)
	const n = 8
	done := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			_, err := Add("", "")
			done <- err
		}()
	}
	for i := 0; i < n; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if chats, err := List(); err != nil || len(chats) != n {
		t.Errorf("kept %d of %d (%v)", len(chats), n, err)
	}
}

func TestAdd_ACorruptListIsLeftAlone(t *testing.T) {
	isolate(t)
	if err := os.WriteFile(File(), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Add("", "x"); err == nil {
		t.Fatal("added over a corrupt list")
	}
	if data, _ := os.ReadFile(File()); string(data) != "not json" {
		t.Errorf("the list was rewritten: %q", data)
	}
}
