package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

const discordUsage = "Usage: crew voice discord setup [--guild=<id>] [--channel=<name|id>] [--user=<id>] | status | off"

// discordSteps is what a first setup needs before crew can do anything.
const discordSteps = `Voice OS in Discord needs a bot of your own:
  1. A Discord server you own, with a voice channel (one named "Voice OS" is picked first).
  2. In the Discord Developer Portal (discord.com/developers/applications), create an app, open Bot, and copy its token (Reset Token).
  3. Invite the bot to your server: OAuth2 → URL Generator, scope bot, permissions View Channel, Connect, Speak.
  4. Run crew voice discord setup and paste the token (or pipe it: pbpaste | crew voice discord setup).`

// voiceDiscord: crew voice discord setup|status|off.
func voiceDiscord(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, discordUsage)
		os.Exit(1)
	}
	switch args[0] {
	case "setup":
		discordSetup(args[1:])
	case "status":
		discordStatus()
	case "off":
		discordOff()
	default:
		fmt.Fprintln(os.Stderr, discordUsage)
		os.Exit(1)
	}
}

func parseDiscordSetupArgs(args []string) (voice.DiscordOptions, error) {
	var opts voice.DiscordOptions
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "--guild="); ok {
			opts.Guild = strings.TrimSpace(v)
		} else if v, ok := strings.CutPrefix(a, "--channel="); ok {
			opts.Channel = strings.TrimSpace(v)
		} else if v, ok := strings.CutPrefix(a, "--user="); ok {
			opts.User = strings.TrimSpace(v)
		} else {
			return voice.DiscordOptions{}, fmt.Errorf("unknown argument %q", a)
		}
	}
	return opts, nil
}

// discordSetup reads the token like keys set does (hidden at a terminal, else
// stdin); nothing given falls back to the token an earlier setup saved, so a
// rerun with --guild or --channel needs no paste.
func discordSetup(args []string) {
	opts, err := parseDiscordSetupArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n%s\n", err, discordUsage)
		os.Exit(1)
	}
	saved := voice.SavedDiscordToken()
	prompt := "Discord bot token (hidden as you paste): "
	if saved != "" {
		prompt = "Discord bot token (hidden as you paste; enter keeps the saved one): "
	}
	token, err := readSecret(prompt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	token, ok := chooseDiscordToken(token, saved)
	if !ok {
		fmt.Fprintln(os.Stderr, discordSteps)
		os.Exit(1)
	}

	res, err := voice.SetupDiscord(token, opts)
	if err != nil {
		if !errors.Is(err, voice.ErrDiscordRejected) && voice.SavedDiscordToken() == token {
			err = fmt.Errorf("%w\n(the token is saved: rerun without pasting it)", err)
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	cfg := res.Config
	fmt.Fprintf(human, "server: %s (%s)\n", cfg.GuildName, cfg.Guild)
	if res.OwnerGiven {
		fmt.Fprintf(human, "you: %s (--user)\n", cfg.Owner)
	} else {
		fmt.Fprintf(human, "you: the server owner (%s)\n", cfg.Owner)
	}
	fmt.Fprintf(human, "channel: %s (%s)\n", cfg.ChannelName, cfg.Channel)
	fmt.Fprintln(human, "ready: Voice OS joins it while it runs")
	if jsonOutput {
		printJSON(cfg)
	}
}

// chooseDiscordToken: a pasted token wins; a blank paste keeps the saved one;
// neither means a first setup, which the caller answers with the steps. Pure.
func chooseDiscordToken(entered, saved string) (string, bool) {
	if token := strings.TrimSpace(entered); token != "" {
		return token, true
	}
	if token := strings.TrimSpace(saved); token != "" {
		return token, true
	}
	return "", false
}

func discordStatus() {
	report, err := voice.InspectDiscord()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(report)
		return
	}
	for _, row := range voice.DiscordStatusRows(report) {
		fmt.Printf("%s\t%s\n", row[0], row[1])
	}
}

func discordOff() {
	removed, err := voice.RemoveDiscord()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(map[string][]string{"removed": removed})
		return
	}
	if len(removed) == 0 {
		fmt.Println("Discord was not set up: nothing to remove.")
		return
	}
	for _, path := range removed {
		fmt.Printf("removed\t%s\n", path)
	}
	fmt.Fprintln(human, "Voice OS leaves Discord; crew voice discord setup brings it back.")
}
