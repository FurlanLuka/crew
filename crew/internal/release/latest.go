package release

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	osexec "os/exec"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// APIBase is a var so tests answer the release lookup from a local server.
var APIBase = "https://api.github.com"

// A version lookup is one small JSON document; a slow API should fall through
// to gh, not hang `crew update`.
var apiClient = &http.Client{Timeout: 15 * time.Second}

// LatestVersion is the newest release's version without the leading "v". The
// public API needs no gh and no login; gh is the fallback for when it is
// unreachable or rate-limited (60 unauthenticated calls an hour per address).
func LatestVersion() (string, error) {
	version, apiErr := latestFromAPI()
	if apiErr == nil {
		return version, nil
	}
	debug.Log("release", "latest release lookup failed, trying gh: %v", apiErr)
	version, ghErr := latestFromGh()
	if ghErr != nil {
		debug.Log("release", "gh fallback failed: %v", ghErr)
		return "", fmt.Errorf("%v; gh fallback: %v", apiErr, ghErr)
	}
	return version, nil
}

func latestFromAPI() (string, error) {
	url := APIBase + "/repos/" + config.Repo + "/releases/latest"
	debug.Log("release", "GET %s", url)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	// GitHub refuses API requests without a User-Agent.
	req.Header.Set("User-Agent", "crew-update")
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := apiClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("github api: %w", err)
	}
	defer resp.Body.Close()
	if rateLimited(resp) {
		return "", fmt.Errorf("github api rate limited (answered %d)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github api answered %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("github api: %w", err)
	}
	return parseLatestVersion(body)
}

// rateLimited: GitHub answers an exhausted budget with 403 (or 429) and a zero
// remaining count; a 403 without it is a different refusal and says so.
func rateLimited(resp *http.Response) bool {
	limitStatus := resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests
	return limitStatus && resp.Header.Get("X-RateLimit-Remaining") == "0"
}

// parseLatestVersion reads tag_name from a releases/latest response.
func parseLatestVersion(body []byte) (string, error) {
	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("reading the latest release: %w", err)
	}
	return versionFromTag(payload.TagName, "the latest release has no tag")
}

func latestFromGh() (string, error) {
	debug.Log("release", "gh api repos/%s/releases/latest --jq .tag_name", config.Repo)
	out, err := osexec.Command("gh", "api", "repos/"+config.Repo+"/releases/latest", "--jq", ".tag_name").Output()
	if err != nil {
		return "", fmt.Errorf("gh api failed: %w (is gh installed and authenticated?)", err)
	}
	return versionFromTag(string(out), "gh api returned no tag")
}

func versionFromTag(tag, missing string) (string, error) {
	version := strings.TrimPrefix(strings.TrimSpace(tag), "v")
	if version == "" {
		return "", errors.New(missing)
	}
	return version, nil
}
