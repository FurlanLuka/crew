package dev

import (
	"os"
	"path/filepath"
	"strings"
)

// ParseEnvFile reads KEY=VALUE lines. Pure.
//
// Deliberately naive: no interpolation, no multi-line values, no `export`.
// It backs a heuristic warning, not a config loader — a line crew can't parse
// is a line crew says nothing about. Later duplicates win, matching how a shell
// sourcing the file would end up.
func ParseEnvFile(content string) map[string]string {
	values := make(map[string]string)
	for k, all := range ParseEnvFileAll(content) {
		values[k] = all[len(all)-1]
	}
	return values
}

// ParseEnvFileAll keeps every value a key is given, in file order. Real env
// files carry the same key several times — a docker-compose hostname under a
// localhost one — and which wins depends on the loader, so the scan looks at
// all of them.
func ParseEnvFileAll(content string) map[string][]string {
	values := make(map[string][]string)

	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}

		key = strings.TrimSpace(key)
		if key == "" || strings.ContainsAny(key, " \t") {
			continue
		}

		values[key] = append(values[key], unquote(strings.TrimSpace(value)))
	}
	return values
}

func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	return v
}

// envFileNames are the files ReadEnvValues looks for, in increasing precedence.
var envFileNames = []string{".env", ".env.local"}

// ReadEnvValues reads the env files in dir. Crew reads these; it never writes
// them — the file stays the human-owned layer, and generated values go into
// process env instead where there is no precedence to lose to.
func ReadEnvValues(dir string) map[string]string {
	values := make(map[string]string)
	for k, all := range ReadEnvValuesAll(dir) {
		values[k] = all[len(all)-1]
	}
	return values
}

// ReadEnvValuesAll reads the env files in dir keeping every value per key.
func ReadEnvValuesAll(dir string) map[string][]string {
	values := make(map[string][]string)
	for _, name := range envFileNames {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		for k, all := range ParseEnvFileAll(string(data)) {
			values[k] = append(values[k], all...)
		}
	}
	return values
}

// PreferLocalhost picks, per key, the value that points at localhost when
// there is one — the scan's question is "does anything here reach a crew
// port", and a duplicated key's other values are the loader's problem.
func PreferLocalhost(all map[string][]string) map[string]string {
	values := make(map[string]string, len(all))
	for k, vs := range all {
		values[k] = vs[len(vs)-1]
		for _, v := range vs {
			if _, ok := ParseLocalhostPort(v); ok {
				values[k] = v
				break
			}
		}
	}
	return values
}
