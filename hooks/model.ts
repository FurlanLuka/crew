// The crew pane's pure core: what crew's JSON means and what the pane shows.
// No mods API here — pane.ts calls it and draws.

export type ServerState = 'up' | 'starting' | 'unreached' | 'quiet' | 'died' | 'stopped'

export interface ServerLine {
  project: string
  server: string
  port: number
  url: string
  state: ServerState
  tail?: string
}

export interface SetupStep {
  name: string
  status: string
  started_at?: string
  took_ms?: number
  detail?: string
}

export interface SetupProject {
  project: string
  state: string
  steps: SetupStep[]
}

export interface Issue {
  stage: string
  project?: string
  server?: string
  reason?: string
  detail?: string
}

export interface WatchDoc {
  ref: string
  running: boolean
  proxied: boolean
  servers: ServerLine[]
  setup: { running: boolean; failed: boolean; projects: SetupProject[] }
  health: { at: string; issues: Issue[] } | null
}

export interface WhichDoc {
  ref: string
  root: string
  project: string
}

// What a clicked action shows on its card until crew answers.
export type Pending = 'restarting' | 'starting' | 'stopping'

// The pane's one view at a time: the server list, a server's log, or a
// project's setup log — one pane, since Desktop drops the first click on
// an unfocused one.
export type View = { kind: 'list' } | { kind: 'logs'; project: string; server: string } | { kind: 'install'; project: string }

// Desktop refuses a drawing whose text holds a control character, and dev
// logs are full of them: CSI colours, OSC hyperlinks, carriage-return redraws.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CONTROL = /[\x00-\x1f\x7f]/g

export function cleanLine(line: string): string {
  // tmux writes pane logs with CRLF endings, so a trailing \r only ends the
  // line; one inside it redraws the line, and what follows the last is what
  // showed.
  const ended = line.replace(/\r+$/, '')
  const shown = ended.includes('\r') ? ended.slice(ended.lastIndexOf('\r') + 1) : ended

  return shown.replace(OSC, '').replace(CSI, '').replace(/\t/g, '  ').replace(CONTROL, '')
}

// Splits a stream's chunks into whole cleaned lines, carrying a partial one.
export function splitChunk(carry: string, chunk: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split('\n')
  const rest = parts.pop() ?? ''

  return { lines: parts.map(cleanLine), carry: rest }
}

export const LOG_LINES = 200

export function appendLines(kept: string[], lines: string[]): string[] {
  return [...kept, ...lines].slice(-LOG_LINES)
}

// Parses one `crew dev watch --json` line; null for anything else.
export function parseWatchLine(line: string): WatchDoc | null {
  try {
    const doc = JSON.parse(line)

    return doc && Array.isArray(doc.servers) ? (doc as WatchDoc) : null
  } catch {
    return null
  }
}

export function parseWhich(stdout: string): WhichDoc | null {
  try {
    const doc = JSON.parse(stdout)

    return typeof doc?.ref === 'string' ? (doc as WhichDoc) : null
  } catch {
    return null
  }
}

// crew prints this when it predates a command the pane needs.
export function isCrewTooOld(stderr: string): boolean {
  return /Unknown (dev )?command '(which|watch)'/.test(stderr)
}

export function serverKey(s: { project: string; server: string }): string {
  return s.project + '/' + s.server
}

const STATE_LABEL: Record<ServerState, string> = {
  up: 'Running',
  starting: 'Starting',
  unreached: 'Not listening',
  quiet: 'Running',
  died: 'Died',
  stopped: 'Stopped',
}

const PENDING_LABEL: Record<Pending, string> = {
  restarting: 'Restarting',
  starting: 'Starting',
  stopping: 'Stopping',
}

export type Tone = 'good' | 'busy' | 'bad' | 'idle'

export function cardState(s: ServerLine, pending?: Pending): { label: string; tone: Tone } {
  if (pending) return { label: PENDING_LABEL[pending], tone: 'busy' }
  if (s.state === 'up' || s.state === 'quiet') return { label: STATE_LABEL[s.state], tone: 'good' }
  if (s.state === 'starting') return { label: STATE_LABEL.starting, tone: 'busy' }
  if (s.state === 'stopped') return { label: STATE_LABEL.stopped, tone: 'idle' }

  return { label: STATE_LABEL[s.state], tone: 'bad' }
}

export function isFailed(s: ServerLine): boolean {
  return s.state === 'died' || s.state === 'unreached'
}

// The last line of a failed server's tail, cleaned — the one line a card has room for.
export function failureLine(s: ServerLine): string {
  const lines = (s.tail ?? '').split('\n').map(cleanLine).filter((l) => l.trim() !== '')

  return lines[lines.length - 1] ?? (s.state === 'died' ? 'exited' : 'nothing answers on its port')
}

export function summary(doc: WatchDoc): string {
  const running = doc.servers.filter((s) => s.state !== 'stopped' && s.state !== 'died').length
  if (doc.servers.length === 0) return 'No dev servers'
  if (!doc.running) return 'Not running'

  return running + ' of ' + doc.servers.length + ' running'
}

// Fix in Claude only where crew has evidence: with nothing recorded and
// nothing failed, `crew fix --print` would start a verify — a side effect a
// button that drafts text must not have.
export function canFix(doc: WatchDoc | null, s?: ServerLine): boolean {
  if (!doc) return false
  if (s) return isFailed(s)

  return (doc.health?.issues.length ?? 0) > 0 || doc.servers.some(isFailed)
}

export function fixDraft(fixPrompt: string, ref: string, s?: ServerLine): string {
  const focus = s ? 'Start with ' + serverKey(s) + ' in ' + ref + ' — it ' + (s.state === 'died' ? 'died' : 'is not listening') + '.\n\n' : ''

  return focus + fixPrompt.trim()
}

export function issueLine(i: Issue): string {
  const where = [i.project, i.server].filter(Boolean).join('/')
  const what = i.reason || i.stage

  return (where ? where + ' — ' : '') + what
}

// The step a runner is on, or its last one, with how long it has taken.
export function setupLine(p: SetupProject, now: number): string {
  const running = p.steps.find((s) => s.status === 'running')
  const step = running ?? p.steps[p.steps.length - 1]
  if (!step) return p.state

  const ms = running && step.started_at ? now - Date.parse(step.started_at) : step.took_ms ?? 0

  return step.name + (ms > 0 ? ' ' + formatDuration(ms) : '')
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return s + 's'

  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's'
}

export function setupBadge(state: string): { label: string; tone: Tone } {
  if (state === 'ok') return { label: 'Ready', tone: 'good' }
  if (state === 'failed' || state === 'interrupted') return { label: 'Failed', tone: 'bad' }

  return { label: 'Setting up', tone: 'busy' }
}

// crew refuses a restart while a setup runner is alive, so the button is
// only there when it can work.
export function canRestart(doc: WatchDoc | null): boolean {
  return !!doc && doc.running && !doc.setup.running
}

export type HeaderActions = 'none' | 'running' | 'stopped'

export function headerActions(doc: WatchDoc): HeaderActions {
  if (doc.setup.running || doc.servers.length === 0) return 'none'

  return doc.running ? 'running' : 'stopped'
}

// Two projects can each run a server of the same name; the card then names
// its project.
export function isNameShared(doc: WatchDoc, s: ServerLine): boolean {
  return doc.servers.some((o) => o !== s && o.server === s.server)
}

// The last non-empty line of a command's output, without crew's "Error: ".
export function lastLine(text: string): string {
  const lines = text.trim().split('\n')

  return (lines[lines.length - 1] ?? '').replace(/^Error: /, '')
}

// Whether two snapshots draw the same pane — a redraw replaces buttons, and
// Desktop drops a click aimed at a replaced one.
export function sameDoc(a: WatchDoc | null, b: WatchDoc | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Claude Desktop starts sessions with a bare PATH: no Homebrew, no
// ~/.local/bin. crew then cannot find tmux and reads every server as dead,
// so the commands the pane runs get those folders added. Pure.
export function withToolDirs(path: string | undefined, home: string | undefined): string {
  const have = (path ?? '').split(':').filter(Boolean)
  const want = [home ? home + '/.local/bin' : '', '/opt/homebrew/bin', '/usr/local/bin'].filter((d) => d && !have.includes(d))

  return [...want, ...have].join(':') || '/usr/bin:/bin'
}
