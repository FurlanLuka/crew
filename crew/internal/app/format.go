package app

import "fmt"

// FormatBytes renders a size the way a human reads it: 1024-based, one
// decimal only while the number is small enough for it to matter.
func FormatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value, exp := float64(n), 0
	for value >= unit && exp < 5 {
		value /= unit
		exp++
	}
	suffix := []string{"KB", "MB", "GB", "TB", "PB"}[exp-1]
	if value < 10 {
		return fmt.Sprintf("%.1f %s", value, suffix)
	}
	return fmt.Sprintf("%.0f %s", value, suffix)
}
