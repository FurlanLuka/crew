package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/registry"
)

func cmdRegistry() {
	if len(os.Args) < 3 {
		runTUI(registry.NewView())
		return
	}

	switch os.Args[2] {
	case "install":
		cmdRegistryInstall()
	case "rm":
		cmdRegistryRm()
	case "update":
		cmdRegistryUpdate()
	default:
		fmt.Fprintf(os.Stderr, "Unknown registry command '%s'.\nUsage: crew registry [install|rm|update]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdRegistryInstall() {
	installAll := false
	var name string

	for _, arg := range os.Args[3:] {
		if arg == "--all" {
			installAll = true
		} else if !strings.HasPrefix(arg, "-") {
			name = arg
		} else {
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'.\nUsage: crew registry install [<name> | --all]\n", arg)
			os.Exit(1)
		}
	}

	if installAll {
		fmt.Println("Installing all agents and skills...")
		fmt.Println()

		installedAgents, failedAgents, agentErr := registry.InstallAllAgents()
		if agentErr != nil {
			fmt.Fprintf(os.Stderr, "Error fetching agents: %v\n", agentErr)
		} else {
			for _, n := range installedAgents {
				fmt.Printf("  Installed agent: %s\n", n)
			}
			for _, n := range failedAgents {
				fmt.Fprintf(os.Stderr, "  Failed agent: %s\n", n)
			}
		}

		installedSkills, failedSkills, skillErr := registry.InstallAllSkills()
		if skillErr != nil {
			fmt.Fprintf(os.Stderr, "Error fetching skills: %v\n", skillErr)
		} else {
			for _, n := range installedSkills {
				fmt.Printf("  Installed skill: %s\n", n)
			}
			for _, n := range failedSkills {
				fmt.Fprintf(os.Stderr, "  Failed skill: %s\n", n)
			}
		}

		total := len(installedAgents) + len(installedSkills)
		if total == 0 && agentErr == nil && skillErr == nil {
			fmt.Println("Everything already installed.")
		} else if total > 0 {
			fmt.Printf("\nInstalled %d items.\n", total)
		}
		return
	}

	if name == "" {
		fmt.Fprintf(os.Stderr, "Usage: crew registry install [<name> | --all]\n")
		os.Exit(1)
	}

	// Try agent first, then skill
	if err := registry.InstallAgent(name); err == nil {
		fmt.Printf("Installed agent: %s\n", name)
		return
	}

	if err := registry.InstallSkill(name); err == nil {
		fmt.Printf("Installed skill: %s\n", name)
		return
	}

	fmt.Fprintf(os.Stderr, "Error: '%s' not found in registry\n", name)
	os.Exit(1)
}

func cmdRegistryRm() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew registry rm <name>\n")
		os.Exit(1)
	}
	name := os.Args[3]

	// Try agent first, then skill
	if err := registry.RemoveAgent(name); err == nil {
		fmt.Printf("Removed: %s\n", name)
		return
	}
	if err := registry.RemoveSkill(name); err == nil {
		fmt.Printf("Removed: %s\n", name)
		return
	}

	fmt.Fprintf(os.Stderr, "Error: '%s' not found\n", name)
	os.Exit(1)
}

func cmdRegistryUpdate() {
	updateAll := false
	var name string

	for _, arg := range os.Args[3:] {
		if arg == "--all" {
			updateAll = true
		} else if !strings.HasPrefix(arg, "-") {
			name = arg
		} else {
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'.\nUsage: crew registry update [<name> | --all]\n", arg)
			os.Exit(1)
		}
	}

	if updateAll {
		updated := 0
		for _, a := range registry.InstalledAgents() {
			changed, err := registry.UpdateAgent(a.Name)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  Error updating agent %s: %v\n", a.Name, err)
				continue
			}
			if changed {
				fmt.Printf("  Updated agent: %s\n", a.Name)
				updated++
			}
		}
		for _, s := range registry.InstalledSkills() {
			changed, err := registry.UpdateSkill(s.Name)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  Error updating skill %s: %v\n", s.Name, err)
				continue
			}
			if changed {
				fmt.Printf("  Updated skill: %s\n", s.Name)
				updated++
			}
		}
		if updated == 0 {
			fmt.Println("Everything up to date.")
		} else {
			fmt.Printf("\nUpdated %d items.\n", updated)
		}
		return
	}

	if name == "" {
		fmt.Fprintf(os.Stderr, "Usage: crew registry update [<name> | --all]\n")
		os.Exit(1)
	}

	// Try agent first, then skill
	if changed, err := registry.UpdateAgent(name); err == nil {
		if changed {
			fmt.Printf("Updated: %s\n", name)
		} else {
			fmt.Println("Already up to date")
		}
		return
	}
	if changed, err := registry.UpdateSkill(name); err == nil {
		if changed {
			fmt.Printf("Updated: %s\n", name)
		} else {
			fmt.Println("Already up to date")
		}
		return
	}

	fmt.Fprintf(os.Stderr, "Error: '%s' not found\n", name)
	os.Exit(1)
}
