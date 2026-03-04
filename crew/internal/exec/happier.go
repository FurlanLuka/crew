package exec

import "os/exec"

// HasHappier checks if happier CLI is available.
func HasHappier() bool {
	_, err := exec.LookPath("happier")
	return err == nil
}
