// Package words is crew's one plural rule for what it prints: "1 project",
// "2 projects".
package words

import "fmt"

// Count is n and the noun, plural unless n is 1: Count(1, "project") is
// "1 project", Count(0, "project") "0 projects".
func Count(n int, one string) string { return CountOf(n, one, one+"s") }

// CountOf is Count for a noun whose plural is not one+"s".
func CountOf(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}
