package exec

import "os/exec"

// HasClaude checks if claude CLI is available.
func HasClaude() bool {
	_, err := exec.LookPath("claude")
	return err == nil
}
