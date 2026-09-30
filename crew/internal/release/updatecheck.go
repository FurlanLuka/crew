package release

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// checkInterval spaces the background update check: every crew command runs
// it, and GitHub gives an address 60 unauthenticated API calls an hour.
const checkInterval = 24 * time.Hour

// cutOffRetry is how soon a check that never finished is tried again. Most crew
// commands exit before the lookup answers, which cuts it off unrecorded.
const cutOffRetry = time.Hour

// updateCheck is the background check's last answer, kept in
// ~/.crew/update-check.json.
type updateCheck struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest,omitempty"`
}

func updateCheckPath() string {
	return filepath.Join(config.ConfigDir, "update-check.json")
}

// checkDue: no record, a record from the future (a clock set back) or one older
// than the interval.
func checkDue(last updateCheck, now time.Time) bool {
	age := now.Sub(last.CheckedAt)
	return last.CheckedAt.IsZero() || age < 0 || age >= checkInterval
}

func readUpdateCheck() updateCheck {
	var last updateCheck
	data, err := os.ReadFile(updateCheckPath())
	if err != nil {
		return last
	}
	if err := json.Unmarshal(data, &last); err != nil {
		debug.Log("release", "update-check.json unreadable, checking again: %v", err)
		return updateCheck{}
	}
	return last
}

func writeUpdateCheck(c updateCheck) {
	data, _ := json.Marshal(c)
	if err := os.WriteFile(updateCheckPath(), data, 0o644); err != nil {
		debug.Log("release", "writing update-check.json failed: %v", err)
	}
}

// StartUpdateCheck is the synchronous half of the "update available" notice:
// the remembered answer, and whether a lookup is due (at most once per
// checkInterval). A due check is claimed here, before any goroutine runs: most
// commands exit before a background lookup answers, and without the claim
// every command would ask GitHub again.
func StartUpdateCheck(now time.Time) (cached string, due bool) {
	last := readUpdateCheck()
	if !checkDue(last, now) {
		return last.Latest, false
	}
	writeUpdateCheck(claimCheck(last, now))
	return last.Latest, true
}

// FinishUpdateCheck looks the release up and records the answer, after
// StartUpdateCheck said a check is due. A failed lookup is stamped too, so a
// rate-limited address does not retry on every command, and keeps the last
// known version. `crew update` calls LatestVersion directly and always asks.
func FinishUpdateCheck(now time.Time) string {
	last := readUpdateCheck()
	if latest, err := LatestVersion(); err == nil {
		last.Latest = latest
	}
	last.CheckedAt = now
	writeUpdateCheck(last)
	return last.Latest
}

// Remember records a version `crew update` just looked up, so the background notice starts from
// the fresh answer instead of offering, for up to a day, the older release it had cached.
func Remember(latest string, now time.Time) {
	writeUpdateCheck(updateCheck{CheckedAt: now, Latest: latest})
}

// IsNewer reports whether release a is newer than b ("5.1.0" vs "5.0.0"). A version that does not
// parse is never newer: the notice stays quiet rather than offering something it cannot compare.
func IsNewer(a, b string) bool {
	pa, okA := parseVersion(a)
	pb, okB := parseVersion(b)
	if !okA || !okB {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3)
	if len(parts) != 3 {
		return out, false
	}
	for i, part := range parts {
		// A pre-release suffix ("0-rc.1") compares by its number alone.
		digits := part
		if cut := strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }); cut >= 0 {
			digits = part[:cut]
		}
		n, err := strconv.Atoi(digits)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// claimCheck is the record written before a lookup starts: due again after
// cutOffRetry, not a whole day, in case the command exits before the answer.
func claimCheck(last updateCheck, now time.Time) updateCheck {
	return updateCheck{CheckedAt: now.Add(cutOffRetry - checkInterval), Latest: last.Latest}
}
