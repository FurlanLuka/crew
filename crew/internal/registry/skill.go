package registry

import (
	"os"
	"path/filepath"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
)

type SkillInfo struct {
	Name        string
	Description string
	Installed   bool
}

// ListSkills returns all skills from the registry with install status.
func ListSkills() ([]SkillInfo, error) {
	entries, err := FetchContents(config.RegistryBase + "/skills")
	if err != nil {
		return nil, err
	}

	var skills []SkillInfo
	for _, e := range entries {
		if e.Type != "dir" {
			continue
		}
		skills = append(skills, SkillInfo{
			Name:      e.Name,
			Installed: isSkillInstalled(e.Name),
		})
	}

	// Fetch descriptions from SKILL.md
	for i, s := range skills {
		content, err := FetchRaw(config.RegistryBase + "/skills/" + s.Name + "/SKILL.md")
		if err == nil {
			skills[i].Description = ParseFrontmatter(content, "description")
		}
	}

	return skills, nil
}

// InstalledSkills returns locally installed skill names.
func InstalledSkills() []SkillInfo {
	dir := filepath.Join(config.ClaudeConfigDir, "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var skills []SkillInfo
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		skillMd := filepath.Join(dir, e.Name(), "SKILL.md")
		if _, err := os.Stat(skillMd); err != nil {
			continue
		}
		desc := ""
		data, err := os.ReadFile(skillMd)
		if err == nil {
			desc = ParseFrontmatter(string(data), "description")
		}
		skills = append(skills, SkillInfo{Name: e.Name(), Description: desc, Installed: true})
	}
	return skills
}

// InstallSkill downloads and installs a skill (full directory).
func InstallSkill(name string) error {
	dir := filepath.Join(config.ClaudeConfigDir, "skills", name)
	os.MkdirAll(dir, 0o755)

	entries, err := FetchContents(config.RegistryBase + "/skills/" + name)
	if err != nil {
		return err
	}

	for _, e := range entries {
		if e.Type == "file" {
			content, err := FetchRaw(config.RegistryBase + "/skills/" + name + "/" + e.Name)
			if err != nil {
				continue
			}
			os.WriteFile(filepath.Join(dir, e.Name), []byte(content), 0o644)
		} else if e.Type == "dir" {
			subDir := filepath.Join(dir, e.Name)
			os.MkdirAll(subDir, 0o755)

			subEntries, err := FetchContents(config.RegistryBase + "/skills/" + name + "/" + e.Name)
			if err != nil {
				continue
			}
			for _, se := range subEntries {
				if se.Type == "file" {
					content, err := FetchRaw(config.RegistryBase + "/skills/" + name + "/" + e.Name + "/" + se.Name)
					if err != nil {
						continue
					}
					os.WriteFile(filepath.Join(subDir, se.Name), []byte(content), 0o644)
				}
			}
		}
	}

	return nil
}

// RemoveSkill removes an installed skill.
func RemoveSkill(name string) error {
	return os.RemoveAll(filepath.Join(config.ClaudeConfigDir, "skills", name))
}

// UpdateSkill updates a skill if SKILL.md changed. Returns true if updated.
func UpdateSkill(name string) (bool, error) {
	local := filepath.Join(config.ClaudeConfigDir, "skills", name, "SKILL.md")
	localData, err := os.ReadFile(local)
	if err != nil {
		return false, err
	}

	remote, err := FetchRaw(config.RegistryBase + "/skills/" + name + "/SKILL.md")
	if err != nil {
		return false, err
	}

	if ContentHash(string(localData)) == ContentHash(remote) {
		return false, nil
	}

	// Re-install fully
	os.RemoveAll(filepath.Join(config.ClaudeConfigDir, "skills", name))
	err = InstallSkill(name)
	return err == nil, err
}

// InstallAllSkills installs all uninstalled skills from the registry.
func InstallAllSkills() (installed []string, failed []string, err error) {
	skills, err := ListSkills()
	if err != nil {
		return nil, nil, err
	}
	for _, s := range skills {
		if s.Installed {
			continue
		}
		if installErr := InstallSkill(s.Name); installErr != nil {
			failed = append(failed, s.Name)
		} else {
			installed = append(installed, s.Name)
		}
	}
	return installed, failed, nil
}

func isSkillInstalled(name string) bool {
	_, err := os.Stat(filepath.Join(config.ClaudeConfigDir, "skills", name, "SKILL.md"))
	return err == nil
}
