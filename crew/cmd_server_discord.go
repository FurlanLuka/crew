package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/voice"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
	"github.com/charmbracelet/x/term"
)

const discordUsage = "Usage: crew server discord setup [--guild=<id>] [--channel=<name|id>] [--text-channel=<name|id|voice>] [--user=<id>] | status | channels | send [--text=<message>] [--file=<path>]… | off"

// discordSteps is what a first setup needs before crew can do anything; the
// last step is how the token comes in, which depends on who is asking.
const discordSteps = `Voice OS in Discord needs a bot of your own:
  1. A Discord server you own, with a voice channel (one named "Voice OS" is picked first).
  2. In the Discord Developer Portal (discord.com/developers/applications), create an app, open Bot, and copy its token (Reset Token).
  3. Invite the bot to your server: OAuth2 → URL Generator, scope bot, permissions View Channel, Connect, Speak.
`

const (
	discordStepPaste = "  4. Paste the bot token below."
	discordStepRun   = "  4. Run crew server discord setup and paste the token (or pipe it: pbpaste | crew server discord setup)."
)

// voiceDiscord: crew server discord setup|status|off.
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
	case "channels":
		discordChannels()
	case "send":
		discordSend(args[1:])
	case "_send":
		discordSendStaged(args[1:])
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
		} else if v, ok := strings.CutPrefix(a, "--text-channel="); ok {
			opts.TextChannel = strings.TrimSpace(v)
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
	isTerminal := term.IsTerminal(os.Stdin.Fd())
	// A first setup at a terminal: what to do in Discord comes before the question.
	if saved == "" && isTerminal {
		fmt.Fprintf(os.Stderr, "%s%s\n\n", discordSteps, discordStepPaste)
	}
	token, err := readSecret(prompt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	token, ok := chooseDiscordToken(token, saved)
	if !ok {
		// The steps are already on screen at a terminal; piped, they are the answer.
		if isTerminal {
			fmt.Fprintln(os.Stderr, "Error: no token pasted")
		} else {
			fmt.Fprintf(os.Stderr, "%s%s\n", discordSteps, discordStepRun)
		}
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
	if cfg.TextChannel == "" {
		fmt.Fprintln(human, "messages: the voice channel's chat")
	} else {
		fmt.Fprintf(human, "messages: #%s (%s)\n", cfg.TextChannelName, cfg.TextChannel)
	}
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
	fmt.Fprintln(human, "Voice OS leaves Discord; crew server discord setup brings it back.")
}

// parseDiscordSendArgs: --text and any number of --file. Pure.
func parseDiscordSendArgs(args []string) (voice.DiscordMessage, bool, error) {
	var msg voice.DiscordMessage
	hasText := false
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "--text="); ok {
			msg.Text, hasText = v, true
		} else if v, ok := strings.CutPrefix(a, "--file="); ok && strings.TrimSpace(v) != "" {
			msg.Files = append(msg.Files, strings.TrimSpace(v))
		} else {
			return voice.DiscordMessage{}, false, fmt.Errorf("unknown argument %q", a)
		}
	}
	return msg, hasText, nil
}

// discordSend posts to the developer's Discord: from the main with its token, from a remote through
// the main (the message is staged here and fetched). Text with no --text comes from stdin when piped.
func discordSend(args []string) {
	msg, hasText, err := parseDiscordSendArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n%s\n", err, discordUsage)
		os.Exit(1)
	}
	// Stdin is the text only when nothing else was given: an agent's open, never-closed stdin must not
	// hang a send of files.
	if !hasText && len(msg.Files) == 0 && !term.IsTerminal(os.Stdin.Fd()) {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: reading stdin: %v\n", err)
			os.Exit(1)
		}
		msg.Text = string(data)
	}
	if voice.CurrentRole(false) == voice.RoleRemote {
		relayDiscordSend(msg)
		return
	}
	sent, err := voice.SendDiscord(msg)
	sayDiscordSent(sent, err)
}

// relayDiscordSend stages the message here and asks the main to post it; the main's answer is
// relayed as it came, and the stage is gone either way.
func relayDiscordSend(msg voice.DiscordMessage) {
	id, err := voice.StageDiscordMessage(msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	reply, err := voice.AskMainWithin(voice.RemoteQuerySocket(), voice.DiscordSendQuery(id, jsonOutput), voice.DiscordSendWait)
	// The main removed its copy and ours over SSH when it fetched it; this covers a main never reached.
	os.RemoveAll(voice.DiscordStageDir(id))
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "Error: cannot reach the main to post it: %v\n", err)
		os.Exit(1)
	case !reply.OK:
		fmt.Fprintf(os.Stderr, "Error: the main did not post it: %s\n", firstNonEmpty(reply.Error, reply.Reason))
		os.Exit(1)
	}
	os.Stdout.WriteString(reply.Value.Stdout)
	os.Stderr.WriteString(reply.Value.Stderr)
	os.Exit(reply.Value.Code)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return "no answer"
}

// parseDiscordSendStagedArgs checks what the main runs for a stage: <stage id>, and the --source the
// main's link added for a remote's (none for the main's own). Mirrors query-allow.ts; the shared
// fixture discord-send.json pins both. Pure.
func parseDiscordSendStagedArgs(args []string) (id, source string, err error) {
	usage := errors.New("usage: crew server discord _send <stage id> [--source=<machine>]")
	if len(args) == 0 || len(args) > 2 || !voice.IsDiscordStageID(args[0]) {
		return "", "", usage
	}
	if len(args) == 2 {
		match := sourcePattern.FindStringSubmatch(args[1])
		if match == nil || match[1] == voice.MainID {
			return "", "", usage
		}
		source = match[1]
	}
	return args[0], source, nil
}

// discordSendStaged is the main posting a stage: its own, or a remote's (--source names it; the
// main's link adds it, never the remote).
func discordSendStaged(args []string) {
	id, source, err := parseDiscordSendStagedArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	sent, err := voice.SendStagedDiscord(id, source)
	sayDiscordSent(sent, err)
}

func sayDiscordSent(sent voice.DiscordSent, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	where := "#" + sent.ChannelName
	if sent.IsVoiceChat {
		where = "the voice channel's chat"
	}
	note := ""
	if sent.TextAttached {
		note = " (the text as message.md: longer than one message)"
	}
	fmt.Fprintf(human, "sent to %s%s: %s\n", where, note, sent.Link)
	if jsonOutput {
		printJSON(sent)
	}
}

func discordChannels() {
	rows, err := voice.DiscordChannels()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(rows)
		return
	}
	for _, row := range rows {
		marks := []string{row.Kind}
		if row.IsVoice {
			marks = append(marks, "voice channel")
		}
		if row.IsCurrent {
			marks = append(marks, "messages go here")
		}
		fmt.Printf("%s\t%s\t%s\n", row.ID, row.Name, strings.Join(marks, ", "))
	}
}

// discordPromptExtras: a session learns of crew server discord send only where it would post.
func discordPromptExtras() []string {
	if voice.DiscordSendReady() {
		return []string{workspace.DiscordSendLine}
	}
	return nil
}
