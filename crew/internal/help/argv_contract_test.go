package help

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The web's Set up turns each SetupCommand into crew argv
// (voiceos/src/crew/commands.ts toCrewArgv); voice-server writes one sample
// per variant to the shared fixture. Every argv must walk this tree: each
// word a documented command or a positional the command takes, each flag
// one it documents. A command renamed or a flag dropped fails here, not on
// someone's page.
func TestSetupArgvWalkTheTree(t *testing.T) {
	path := filepath.Join("..", "..", "..", "voiceos", "test", "fixtures", "shared", "setup-argv.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (voice-server writes it: cd voiceos && UPDATE_FIXTURES=1 bun test src/crew/commands.spec.ts)", path, err)
	}
	var samples []struct {
		Type string   `json:"type"`
		Argv []string `json:"argv"`
	}
	if err := json.Unmarshal(data, &samples); err != nil {
		t.Fatal(err)
	}
	if len(samples) == 0 {
		t.Fatal("the fixture is empty")
	}
	for _, s := range samples {
		if err := walkArgv(s.Argv); err != "" {
			t.Errorf("%s (%s): %s", s.Type, strings.Join(s.Argv, " "), err)
		}
	}
}

func TestWalkArgv(t *testing.T) {
	for argv, want := range map[string]string{
		"ls bindings store-api --preview --json": "",
		"voice keys set soniox --json":           "",
		"server status":                          "",
		"import - --plan":                        "",
		"ls nope":                                "'nope' is not a command of crew ls",
		"dev add store-api --nope=1":             "flag --nope=1 is not one crew dev add takes",
		"workspaces":                             "'workspaces' is not a command of crew",
		"add project a b c d":                    "crew add project takes at most 2 positionals, got 4",
		"rm worktree a/b --pull":                 "flag --pull is not one crew rm worktree takes",
		"rm worktree a/b --dry":                  "flag --dry is not one crew rm worktree takes",
		"env store-front/main store-api extra":   "crew env takes at most 2 positionals, got 3",
		"import - project store-api":             "",
		"import - project store-api extra":       "crew import takes at most 3 positionals, got 4",
		"verify store-front/main a b c":          "",
		"run store-front/main store-api -- x -y": "",
		"server machines add vm1 --name=box":     "",
		"dev logs a/b web -f --lines=10":         "",
	} {
		if got := walkArgv(strings.Fields(argv)); got != want {
			t.Errorf("walkArgv(%s) = %q, want %q", argv, got, want)
		}
	}
}

// walkArgv returns "" when argv names a documented command with flags it
// documents and no more positionals than its usage has room for, else what
// is wrong.
func walkArgv(argv []string) string {
	path := []*CommandInfo{&Root}
	names := []string{"crew"}
	positionals := 0
	for i, word := range argv {
		cur := path[len(path)-1]
		if i == 0 && word == "voice" {
			// The alias main dispatches to crew server, kept forever.
			word = "server"
		}
		if word == "--" {
			// crew run hands the rest to the child untouched.
			break
		}
		if strings.HasPrefix(word, "-") && word != "-" {
			if !flagKnown(cur, word) {
				return "flag " + word + " is not one " + strings.Join(names, " ") + " takes"
			}
			continue
		}
		if sub := findSubcommand(cur, word); sub != nil && positionals == 0 {
			path = append(path, sub)
			names = append(names, word)
			continue
		}
		if !takesPositional(cur, word) {
			return "'" + word + "' is not a command of " + strings.Join(names, " ")
		}
		positionals++
	}
	room, variadic := positionalRoom(path[len(path)-1], names)
	if !variadic && positionals > room {
		return fmt.Sprintf("%s takes at most %d positionals, got %d", strings.Join(names, " "), room, positionals)
	}
	return ""
}

var (
	placeholder = regexp.MustCompile(`<[^>]*>`)
	flagName    = regexp.MustCompile(`^-{1,2}[a-z][a-z-]*=?`)
)

// flattenPlaceholders turns every <…> into one word, keeping whether it was
// variadic: <ssh host> is one positional, <command...> any number.
func flattenPlaceholders(usage string) string {
	return placeholder.ReplaceAllStringFunc(usage, func(m string) string {
		if strings.Contains(m, "...") {
			return "<x>..."
		}
		return "<x>"
	})
}

// flagKnown: --json is global; any other flag is one the command itself
// spells — in a flag entry or its usage line — matched as a whole name
// (up to and including any "="), never as a substring and never a
// parent's.
func flagKnown(c *CommandInfo, word string) bool {
	name := word
	if i := strings.Index(word, "="); i >= 0 {
		name = word[:i+1]
	}
	return name == "--json" || commandFlags(c)[name]
}

func commandFlags(c *CommandInfo) map[string]bool {
	words := strings.Fields(flattenPlaceholders(c.Usage))
	for _, f := range c.Flags {
		words = append(words, strings.Split(f.Name, ", ")...)
	}
	flags := map[string]bool{}
	for _, w := range words {
		for _, alt := range strings.Split(strings.Trim(w, "[]()"), "|") {
			if m := flagName.FindString(strings.Trim(alt, "[]()")); m != "" {
				flags[m] = true
			}
		}
	}
	return flags
}

// positionalRoom is how many positionals the widest form of the usage takes
// after the command's own words; variadic when one form ends in "...". A
// form that does not start with "crew" continues the last one that did
// (crew import <file> [--plan | project <name>]).
func positionalRoom(c *CommandInfo, names []string) (int, bool) {
	most, base, variadic := 0, 0, false
	for _, form := range strings.Split(flattenPlaceholders(c.Usage), " | ") {
		words := strings.Fields(form)
		count := base
		head := len(words) > 0 && words[0] == "crew"
		if head {
			words = words[1:]
			for _, name := range names[1:] {
				if len(words) > 0 && words[0] == name {
					words = words[1:]
				}
			}
			count = 0
		}
		n, v := slots(words)
		count += n
		variadic = variadic || v
		if head {
			base = count
		}
		most = max(most, count)
	}
	return most, variadic
}

// slots counts a form's positional words: placeholders and literal words,
// not flags.
func slots(words []string) (n int, variadic bool) {
	for _, w := range words {
		t := strings.Trim(w, "[]()")
		switch {
		case strings.Contains(t, "..."):
			variadic = true
		case t == "", strings.HasPrefix(t, "-") && t != "-":
		default:
			n++
		}
	}
	return n, variadic
}

// takesPositional: the command's usage has a placeholder, or names the
// word itself ([empty], [status|trust]).
func takesPositional(c *CommandInfo, word string) bool {
	if strings.Contains(c.Usage, "<") {
		return true
	}
	for _, f := range strings.FieldsFunc(c.Usage, func(r rune) bool { return strings.ContainsRune(" []|", r) }) {
		if f == word {
			return true
		}
	}
	return false
}

// The crew pane (hooks/pane.ts in the plugin) runs these; its tests assert
// it calls exactly them, so a command or flag the pane relies on cannot
// disappear from the CLI unnoticed.
func TestPaneArgvWalkTheTree(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "crew-argv.json"))
	if err != nil {
		t.Fatal(err)
	}
	var argvs [][]string
	if err := json.Unmarshal(data, &argvs); err != nil {
		t.Fatal(err)
	}
	for _, argv := range argvs {
		if err := walkArgv(argv); err != "" {
			t.Errorf("%s: %s", strings.Join(argv, " "), err)
		}
	}
}
