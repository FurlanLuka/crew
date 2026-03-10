package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/plans"
)

func cmdPlans() {
	if len(os.Args) < 3 {
		runTUI(plans.NewView())
		return
	}

	switch os.Args[2] {
	case "start":
		settings := config.LoadSettings()
		host := dev.ResolveHostIP()
		domain := settings.GetDomain(host)
		proxyPort := settings.GetProxyPort()
		if err := plans.Start(domain, proxyPort); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Plan viewer started\n  %s\n", plans.URL())
	case "stop":
		plans.Stop()
		fmt.Println("Plan viewer stopped")
	case "_serve":
		cmdPlansServe()
	default:
		fmt.Fprintf(os.Stderr, "Unknown plans command '%s'.\nUsage: crew plans [start|stop]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdPlansServe() {
	port := 3080
	for _, arg := range os.Args[3:] {
		if strings.HasPrefix(arg, "--port=") {
			if n, _ := fmt.Sscanf(strings.TrimPrefix(arg, "--port="), "%d", &port); n != 1 {
				fmt.Fprintf(os.Stderr, "Error: invalid --port value\n")
				os.Exit(1)
			}
		}
	}
	if err := plans.RunServer(port); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
