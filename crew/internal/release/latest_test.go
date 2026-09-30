package release

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseLatestVersion(t *testing.T) {
	cases := []struct {
		name, body, want, wantErr string
	}{
		{"a canned releases/latest → the version without v", `{"url":"x","tag_name":"v5.0.0","name":"v5.0.0","draft":false}`, "5.0.0", ""},
		{"a tag without v → as is", `{"tag_name":"4.3.1"}`, "4.3.1", ""},
		{"no tag → an error", `{"message":"Not Found"}`, "", "no tag"},
		{"not JSON → an error", `<html>`, "", "reading the latest release"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseLatestVersion([]byte(tc.body))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tc.wantErr)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("= %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func serveAPI(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	saved := APIBase
	APIBase = server.URL
	t.Cleanup(func() { APIBase = saved })
}

func TestLatestFromAPI_AnswersWithTheTag(t *testing.T) {
	var path, agent string
	serveAPI(t, func(w http.ResponseWriter, r *http.Request) {
		path, agent = r.URL.Path, r.Header.Get("User-Agent")
		w.Write([]byte(`{"tag_name":"v5.0.0"}`))
	})

	got, err := latestFromAPI()

	if err != nil || got != "5.0.0" {
		t.Fatalf("= %q, %v; want 5.0.0", got, err)
	}
	if path != "/repos/FurlanLuka/crew/releases/latest" {
		t.Errorf("path = %q", path)
	}
	if agent == "" {
		t.Error("no User-Agent: GitHub refuses those")
	}
}

func TestLatestFromAPI_RateLimited_IsAnError(t *testing.T) {
	serveAPI(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"API rate limit exceeded"}`, http.StatusForbidden)
	})

	if _, err := latestFromAPI(); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("err = %v, want a 403", err)
	}
}

func TestLatestFromAPI_ExhaustedBudget_SaysRateLimited(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		serveAPI(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.WriteHeader(status)
		})

		if _, err := latestFromAPI(); err == nil || !strings.Contains(err.Error(), "rate limited") {
			t.Fatalf("%d: err = %v, want rate limited", status, err)
		}
	}
}

// fakeGh puts a gh on PATH (and nothing else) that prints tag; an empty tag
// with present=false leaves gh off PATH altogether.
func fakeGh(t *testing.T, present bool, tag string) {
	t.Helper()
	dir := t.TempDir()
	if present {
		script := "#!/bin/sh\necho '" + tag + "'\n"
		if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
}

func TestLatestVersion(t *testing.T) {
	cases := []struct {
		name      string
		apiStatus int
		ghPresent bool
		ghTag     string
		want      string
		wantErr   []string
	}{
		{"the API answers → its tag, gh never asked", http.StatusOK, true, "v9.9.9", "5.0.0", nil},
		{"the API refuses → gh's tag", http.StatusForbidden, true, "v5.0.1", "5.0.1", nil},
		{"the API refuses, no gh → both failures", http.StatusForbidden, false, "", "", []string{"github api answered 403", "gh fallback"}},
		{"gh prints nothing → no tag", http.StatusForbidden, true, "", "", []string{"no tag"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			serveAPI(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.apiStatus != http.StatusOK {
					w.WriteHeader(tc.apiStatus)
					return
				}
				w.Write([]byte(`{"tag_name":"v5.0.0"}`))
			})
			fakeGh(t, tc.ghPresent, tc.ghTag)

			got, err := LatestVersion()

			if tc.wantErr != nil {
				if err == nil {
					t.Fatalf("= %q, want an error", got)
				}
				for _, want := range tc.wantErr {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("err = %v, want it to mention %q", err, want)
					}
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("= %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestCheckDue(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		last updateCheck
		want bool
	}{
		{"never checked → due", updateCheck{}, true},
		{"an hour ago → not due", updateCheck{CheckedAt: now.Add(-time.Hour), Latest: "5.0.0"}, false},
		{"a day ago → due", updateCheck{CheckedAt: now.Add(-24 * time.Hour)}, true},
		{"in the future (clock set back) → due", updateCheck{CheckedAt: now.Add(time.Hour)}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := checkDue(tc.last, now); got != tc.want {
				t.Fatalf("checkDue = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestUpdateCheck_CachesForADay(t *testing.T) {
	t.Cleanup(func() { os.Remove(updateCheckPath()) })
	calls := 0
	serveAPI(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"tag_name":"v5.0.0"}`))
	})
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

	first := checkOnce(now)
	second := checkOnce(now.Add(time.Hour))

	if first != "5.0.0" || second != "5.0.0" || calls != 1 {
		t.Fatalf("= %q then %q after %d lookups; want 5.0.0 twice from one lookup", first, second, calls)
	}
	if got := readUpdateCheck(); !got.CheckedAt.Equal(now) || got.Latest != "5.0.0" {
		t.Fatalf("record = %+v", got)
	}

	checkOnce(now.Add(25 * time.Hour))
	if calls != 2 {
		t.Fatalf("%d lookups after a day, want 2", calls)
	}
}

func TestUpdateCheck_AFailureIsStampedAndKeepsTheLastVersion(t *testing.T) {
	t.Cleanup(func() { os.Remove(updateCheckPath()) })
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	writeUpdateCheck(updateCheck{CheckedAt: now.Add(-48 * time.Hour), Latest: "4.9.0"})
	serveAPI(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	fakeGh(t, false, "")

	got := checkOnce(now)

	if got != "4.9.0" {
		t.Fatalf("= %q, want the remembered 4.9.0", got)
	}
	if rec := readUpdateCheck(); !rec.CheckedAt.Equal(now) {
		t.Fatalf("record = %+v, want it stamped now", rec)
	}
}

func TestRemember_ReplacesAnOlderCachedVersionWithoutALookup(t *testing.T) {
	t.Cleanup(func() { os.Remove(updateCheckPath()) })
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	writeUpdateCheck(updateCheck{CheckedAt: now.Add(-time.Hour), Latest: "5.0.0"})
	calls := 0
	serveAPI(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"tag_name":"v9.9.9"}`))
	})

	Remember("5.1.0", now)

	if got := checkOnce(now.Add(time.Hour)); got != "5.1.0" || calls != 0 {
		t.Fatalf("= %q after %d lookups; want the remembered 5.1.0 with no lookup", got, calls)
	}
}

func TestIsNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"5.1.0", "5.0.0", true},
		{"5.0.0", "5.1.0", false},
		{"5.0.0", "5.0.0", false},
		{"10.0.0", "9.9.9", true},
		{"v5.0.1", "5.0.0", true},
		{"5.0.0-rc.1", "4.9.0", true},
		{"", "5.0.0", false},
		{"5.0", "4.0.0", false},
		{"5.0.0", "dev", false},
	}
	for _, c := range cases {
		if got := IsNewer(c.a, c.b); got != c.want {
			t.Errorf("IsNewer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestClaimCheck_ACutOffLookupIsRetriedWithinTheHourNotEveryCommand(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	claimed := claimCheck(updateCheck{Latest: "4.1.0"}, now)

	if claimed.Latest != "4.1.0" {
		t.Fatalf("claim dropped the last known version: %+v", claimed)
	}
	if checkDue(claimed, now.Add(30*time.Minute)) {
		t.Fatal("due again after 30 minutes: every quick command would ask GitHub")
	}
	if !checkDue(claimed, now.Add(61*time.Minute)) {
		t.Fatal("not due after an hour: a cut-off check would wait a whole day")
	}
}

// checkOnce is what main does for one command that lives long enough for the lookup to answer.
func checkOnce(now time.Time) string {
	cached, due := StartUpdateCheck(now)
	if !due {
		return cached
	}
	return FinishUpdateCheck(now)
}

func TestStartUpdateCheck_ClaimsBeforeTheLookupSoACutOffCommandDoesNotAskAgain(t *testing.T) {
	t.Cleanup(func() { os.Remove(updateCheckPath()) })
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	Remember("4.1.0", now.Add(-25*time.Hour))

	cached, due := StartUpdateCheck(now)
	if cached != "4.1.0" || !due {
		t.Fatalf("first command: cached %q due %v, want 4.1.0 true", cached, due)
	}
	// The command exited before FinishUpdateCheck: the next ones within the hour stay quiet.
	if cached, due := StartUpdateCheck(now.Add(time.Minute)); cached != "4.1.0" || due {
		t.Fatalf("next command: cached %q due %v, want 4.1.0 false", cached, due)
	}
	if _, due := StartUpdateCheck(now.Add(cutOffRetry)); !due {
		t.Fatal("an hour after a cut-off lookup the check should be due again")
	}
}
