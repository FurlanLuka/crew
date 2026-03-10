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
	default:
		fmt.Fprintf(os.Stderr, "Unknown registry command '%s'.\nUsage: crew registry [install]\n", os.Args[2])
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
