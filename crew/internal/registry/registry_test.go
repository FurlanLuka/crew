package registry

import (
	"testing"
)

func TestContentHash(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		// SHA256 of "hello"
		{"hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},
		// SHA256 of empty string
		{"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := ContentHash(tt.input)
			if got != tt.want {
				t.Errorf("ContentHash(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestContentHash_Deterministic(t *testing.T) {
	input := "some content to hash"
	h1 := ContentHash(input)
	h2 := ContentHash(input)
	if h1 != h2 {
		t.Errorf("ContentHash not deterministic: %q != %q", h1, h2)
	}
}

func TestParseFrontmatter(t *testing.T) {
	tests := []struct {
		name    string
		content string
		key     string
		want    string
	}{
		{
			"standard",
			"---\ndescription: A cool agent\nauthor: test\n---\n# Content",
			"description",
			"A cool agent",
		},
		{
			"missing key",
			"---\ndescription: Agent\n---\n# Content",
			"author",
			"",
		},
		{
			"no frontmatter",
			"# Just markdown\nNo frontmatter here.",
			"description",
			"",
		},
		{
			"empty frontmatter",
			"---\n---\n# Content",
			"description",
			"",
		},
		{
			"multi-key",
			"---\nname: Test\ndescription: A test thing\nversion: 1.0\n---\n",
			"version",
			"1.0",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseFrontmatter(tt.content, tt.key)
			if got != tt.want {
				t.Errorf("ParseFrontmatter(%q) = %q, want %q", tt.key, got, tt.want)
			}
		})
	}
}

func TestParseFrontmatter_NoMatch(t *testing.T) {
	content := "---\nfoo: bar\n---\n"
	got := ParseFrontmatter(content, "baz")
	if got != "" {
		t.Errorf("ParseFrontmatter for missing key = %q, want empty", got)
	}
}
