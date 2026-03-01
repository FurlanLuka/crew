package exec

import "os/exec"

// HasHappy checks if happy CLI is available.
func HasHappy() bool {
	_, err := exec.LookPath("happy")
	return err == nil
}
