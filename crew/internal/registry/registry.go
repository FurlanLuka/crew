package registry

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	osexec "os/exec"
	"strings"
	"sync"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
)

var httpClient = &http.Client{}

var ghToken string
var ghTokenOnce sync.Once

func resolveGHToken() string {
	ghTokenOnce.Do(func() {
		if t := os.Getenv("GITHUB_TOKEN"); t != "" {
			ghToken = t
			return
		}
		if out, err := osexec.Command("gh", "auth", "token").Output(); err == nil {
			ghToken = strings.TrimSpace(string(out))
		}
	})
	return ghToken
}

func ghGet(url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	if token := resolveGHToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return httpClient.Do(req)
}

// ghContentsEntry is a single entry from the GitHub contents API.
type ghContentsEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // "file" or "dir"
}

// FetchContents fetches directory listing from GitHub contents API.
func FetchContents(path string) ([]ghContentsEntry, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/contents/%s?ref=%s",
		config.RegistryRepo, path, config.RegistryBranch)

	resp, err := ghGet(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}

	var entries []ghContentsEntry
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// FetchRaw downloads raw file content from GitHub.
func FetchRaw(path string) (string, error) {
	url := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s",
		config.RegistryRepo, config.RegistryBranch, path)

	resp, err := ghGet(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("not found: %s", path)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ContentHash returns the SHA256 hash of content.
func ContentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", h)
}

// ParseFrontmatter extracts a value from YAML front matter.
func ParseFrontmatter(content, key string) string {
	lines := strings.Split(content, "\n")
	inFrontmatter := false
	prefix := key + ":"

	for _, line := range lines {
		if strings.TrimSpace(line) == "---" {
			if inFrontmatter {
				break
			}
			inFrontmatter = true
			continue
		}
		if inFrontmatter && strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	return ""
}
