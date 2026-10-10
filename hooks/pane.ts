// The crew pane: a worktree's dev servers, setup and failures inside a Claude
// Code session, with buttons that run crew. Every fact comes from crew's own
// commands (`which`, `dev watch`, `dev logs`, `fix --print`); this file only
// draws them and runs the commands the buttons name.
import { atom, read, update } from 'claude-code'
import {
  LOG_LINES,
  appendLines,
  canFix,
  canRestart,
  cardState,
  cleanLine,
  failureLine,
  fixDraft,
  headerActions,
  isCrewTooOld,
  isFailed,
  isNameShared,
  issueLine,
  lastLine,
  parseWatchLine,
  parseWhich,
  sameDoc,
  serverKey,
  setupBadge,
  setupLine,
  splitChunk,
  summary,
  type Pending,
  type ServerLine,
  type Tone,
  type View,
  type WatchDoc,
  withToolDirs,
} from './model.ts'

const PANE = 'crew'
const LIST: View = { kind: 'list' }

// In $.state, so writing one redraws only what reads it: Desktop drops a
// click aimed at a button a redraw has replaced.
const docAtom = atom({ plugin: 'crew', key: 'doc' }, null as WatchDoc | null)
const viewAtom = atom({ plugin: 'crew', key: 'view' }, LIST)
const logAtom = atom({ plugin: 'crew', key: 'log' }, [] as string[])
const pendingAtom = atom({ plugin: 'crew', key: 'pending' }, {} as Record<string, Pending>)
const noticeAtom = atom({ plugin: 'crew', key: 'notice' }, '')

let crew = 'crew'
let crewEnv: Record<string, string> = {}
let ref = ''
let orientation: string | null = null
let isWatching = false
let isTicking = false
let ticks = 0
let watchStream: AsyncGenerator<{ text: string }> | null = null
let logStream: AsyncGenerator<{ text: string }> | null = null
let logLines: string[] = []
let isLogDirty = false
let logTarget = ''
let installProject = ''
// Desktop retires a button on every redraw and drops a click aimed at a
// retired one, so the live log redraws there at most every two seconds.
let surface = ''
// The card whose Logs button opened the log view, focused again on Back:
// a focused control that vanishes leaves the pane unfocused, and Desktop
// spends the next click refocusing it. autoFocus only acts when a pane
// opens, so the focus is moved explicitly.
let returnFocus = ''

const TONE_COLOR: Record<Tone, string> = { good: 'green', busy: 'yellow', bad: 'red', idle: 'gray' }

export function register(on) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Claude Desktop starts its sessions as non-interactive with no surface,
    // like claude -p and the Agent SDK behind Voice OS, so nothing here can
    // tell them apart: every session gets the pane, and one nobody draws
    // never watches. The folder decides the worktree, never CREW_REF: a
    // process started from another worktree's session inherits that one's.
    crewEnv = { PATH: withToolDirs(await $.env.get('PATH'), await $.env.get('HOME')) }
    const found = await findWorktree($, e.cwd)
    if (!found) return started
    ref = found
    // A worktree with no dev servers has nothing to show.
    if (!(await hasServers($))) return started

    try {
      await $.command.register({ name: 'crew-pane', description: 'Open the crew pane: dev servers, logs, setup', immediate: true })
    } catch {
      // Another plugin took the name; the pane still opens by itself.
    }
    await $.ui.open({ id: PANE, title: 'crew ' + ref })

    return started
  })

  on('command.run', { command: 'crew-pane' }, async ($) => {
    if (!ref) return { text: 'This folder is not in a crew worktree.' }
    await $.ui.open({ id: PANE, title: 'crew ' + ref, focus: true })

    return {}
  })

  // A Desktop session, or a claude started by hand, has no orientation from
  // crew's launch; crew's own launches set CREW_REF and pass it already.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (!ref || (await $.env.get('CREW_REF')) === ref) return result
    if (orientation === null) {
      try {
        const out = await $.process.run([crew, 'start', ref], { env: crewEnv })
        orientation = out.exitCode === 0 ? out.stdout.trim() : ''
      } catch {
        orientation = ''
      }
    }
    if (!orientation) return result

    return { ...result, blocks: [...result.blocks, { name: 'crew', text: orientation }] }
  })

  // Closing the pane stops everything it ran; reopening starts at the list.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await stopStreams()
      await update($, viewAtom, () => LIST)
    }

    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    surface = e.surface
    startWatching($)
    const doc = await read($, docAtom)
    const view = await read($, viewAtom)
    const pending = await read($, pendingAtom)
    if (view.kind === 'logs') return drawLogs($, e, view, doc, await read($, logAtom), pending)
    if (view.kind === 'install') return drawInstall($, e, view, await read($, logAtom))

    return drawList($, e, doc, pending, await read($, noticeAtom))
  })
}

async function hasServers($): Promise<boolean> {
  try {
    const out = await $.process.run([crew, 'dev', 'watch', ref, '--once', '--json'], { env: crewEnv })
    const doc = parseWatchLine(out.stdout.trim())

    return !doc || doc.servers.length > 0
  } catch {
    return true
  }
}

// crew may not be on a Desktop or SSH session's PATH.
async function findWorktree($, cwd: string): Promise<string> {
  const home = await $.env.get('HOME')
  for (const bin of ['crew', home ? home + '/.local/bin/crew' : '']) {
    if (!bin) continue
    try {
      const out = await $.process.run([bin, 'which', cwd, '--json'], { env: crewEnv })
      crew = bin
      if (out.exitCode === 0) return parseWhich(out.stdout)?.ref ?? ''
      if (isCrewTooOld(out.stderr)) $.ui.toast('crew is older than its Claude pane — run crew update')

      return ''
    } catch {
      // Not found under that name: try the next.
    }
  }

  return ''
}

// `crew dev watch` prints a snapshot whenever anything changes; the pane
// follows it while drawn, and starts it again if it ends.
function startWatching($) {
  if (isWatching) return
  isWatching = true
  if (!isTicking) {
    isTicking = true
    $.clock.every(1000, () => onTick($))
  }
  void watchLoop($)
}

async function watchLoop($) {
  let backoff = 1000
  while (isWatching) {
    const stream = $.process.spawn({ argv: [crew, 'dev', 'watch', ref, '--json'], env: crewEnv })
    watchStream = stream
    let carry = ''
    try {
      for await (const { text } of stream) {
        const split = splitChunk(carry, text)
        carry = split.carry
        for (const line of split.lines) {
          const doc = parseWatchLine(line)
          if (doc) await showDoc($, doc)
        }
        backoff = 1000
      }
    } catch {
      // The stream failed to start or broke; wait and try again below.
    }
    if (!isWatching) return
    try {
      await $.clock.sleep(backoff)
    } catch {
      // The module unloaded mid-wait.
      isWatching = false

      return
    }
    backoff = Math.min(backoff * 2, 10000)
  }
}

async function showDoc($, doc: WatchDoc) {
  if (sameDoc(await read($, docAtom), doc)) return
  await update($, docAtom, () => doc)
}

async function stopStreams() {
  isWatching = false
  logTarget = ''
  installProject = ''
  await watchStream?.return(undefined)
  await logStream?.return(undefined)
  watchStream = null
  logStream = null
}

// Log lines arrive in bursts: at most one redraw a second, every other one
// in Desktop. An install log only grows, so every other second suits it.
async function onTick($) {
  if (!isWatching) return
  ticks += 1
  if (installProject && ticks % 2 === 0) await refreshInstallLog($)
  if (!isLogDirty || (surface === 'desktop' && ticks % 2 !== 0)) return
  isLogDirty = false
  await update($, logAtom, () => logLines)
}

async function openLogs($, s: ServerLine) {
  returnFocus = serverKey(s)
  await update($, viewAtom, () => ({ kind: 'logs', project: s.project, server: s.server }) as View)
  await moveFocus($, 'back')
  await followLog($, serverKey(s))
}

// The log file is emptied when its server starts, which `tail -f` does not
// reliably follow: a restart of the server on screen restarts the stream.
async function followLog($, target: string) {
  await logStream?.return(undefined)
  logTarget = target
  logLines = []
  await update($, logAtom, () => [])
  const stream = $.process.spawn({ argv: [crew, 'dev', 'logs', ref, target, '-f'], env: crewEnv })
  logStream = stream
  let carry = ''
  try {
    for await (const { text } of stream) {
      if (logTarget !== target) return
      const split = splitChunk(carry, text)
      carry = split.carry
      logLines = appendLines(logLines, split.lines)
      isLogDirty = true
    }
  } catch {
    // No log yet, or the stream was closed: the view shows what it has.
  }
}

async function backToList($) {
  logTarget = ''
  installProject = ''
  await logStream?.return(undefined)
  logStream = null
  await update($, viewAtom, () => LIST)
  if (returnFocus) await moveFocus($, 'logs-' + returnFocus)
}

// Best effort: a pane that does not hold the keys answers { deny }.
async function moveFocus($, key: string) {
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {
    // Nothing to do; the next click focuses the pane.
  }
}

async function openInstall($, project: string) {
  installProject = project
  await update($, viewAtom, () => ({ kind: 'install', project }) as View)
  await moveFocus($, 'back')
  await refreshInstallLog($)
}

async function refreshInstallLog($) {
  const project = installProject
  if (!project) return
  try {
    const out = await $.process.run([crew, 'setup', 'logs', ref, project, '--json', '--lines=' + LOG_LINES], { env: crewEnv })
    const lines = (JSON.parse(out.stdout).lines ?? []) as string[]
    if (installProject !== project) return
    logLines = appendLines([], lines.map(cleanLine))
    isLogDirty = true
  } catch {
    // No log yet, or crew could not be run: the view keeps what it has.
  }
}

// Runs one crew command for a button: the card shows what is happening at
// once, and crew's own error line if it refuses.
async function runAction($, key: string, pending: Pending, argv: string[]) {
  await update($, pendingAtom, (p) => ({ ...p, [key]: pending }))
  await update($, noticeAtom, () => '')
  try {
    const out = await $.process.run(argv, { env: crewEnv, timeoutMs: 120000 })
    if (out.exitCode !== 0) {
      await update($, noticeAtom, () => cleanLine(lastLine(out.stderr)) || 'crew ' + argv.slice(1, 3).join(' ') + ' failed')
    }
  } catch (err) {
    await update($, noticeAtom, () => cleanLine(String(err)))
  }
  await update($, pendingAtom, (p) => {
    const rest = { ...p }
    delete rest[key]

    return rest
  })
}

async function restartServer($, s: ServerLine) {
  await runAction($, serverKey(s), 'restarting', [crew, 'dev', 'restart', ref, serverKey(s)])
  if (logTarget === serverKey(s)) void followLog($, logTarget)
}

async function draftFix($, s?: ServerLine) {
  try {
    const out = await $.process.run([crew, 'fix', ref, '--print'], { env: crewEnv, timeoutMs: 60000 })
    if (out.exitCode !== 0 || !out.stdout.trim()) {
      $.ui.toast('crew fix had nothing to say — ' + (lastLine(out.stderr) || 'no output'))

      return
    }
    const filled = await $.prompt.fill({ text: fixDraft(out.stdout, ref, s) })
    if (filled && filled.isFilled === false) $.ui.toast('The prompt box is busy — try Fix in Claude again once it is empty')
  } catch {
    $.ui.toast('Could not put the fix prompt in the prompt box')
  }
}

function drawList($, e, doc: WatchDoc | null, pending: Record<string, Pending>, notice: string) {
  const { Box, Text, Button } = $.ui.resolve(e)
  if (!doc) return Text({ dimColor: true, children: ['Looking at ' + ref + '…'] })

  const actions = headerActions(doc)
  // Fix in Claude sits with the worktree's other actions, there only when
  // crew has evidence of something failed.
  const buttons = [
    ...(actions === 'running'
      ? [
          Button({ key: 'restart-all', label: 'Restart all', onPress: () => void runAction($, '*', 'restarting', [crew, 'dev', 'restart', ref]) }),
          Button({ key: 'stop-all', label: 'Stop', onPress: () => void runAction($, '*', 'stopping', [crew, 'dev', 'stop', ref]) }),
          // The proxy is a whole-worktree mode: switching it restarts every server.
          Button({
            key: 'proxy',
            label: doc.proxied ? 'Proxy: on' : 'Proxy: off',
            onPress: () => void runAction($, '*', 'restarting', [crew, 'dev', 'restart', ref, doc.proxied ? '--no-proxy' : '--proxy']),
          }),
        ]
      : actions === 'stopped'
        ? [Button({ key: 'start-all', label: 'Start all', onPress: () => void runAction($, '*', 'starting', [crew, 'dev', 'start', ref]) })]
        : []),
    ...(canFix(doc) && !doc.setup.running ? [Button({ key: 'fix-all', label: 'Fix in Claude', onPress: () => void draftFix($) })] : []),
  ]

  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      Box({
        flexDirection: 'column',
        children: [Text({ bold: true, children: [summary(doc)] }), ...(buttons.length ? [Box({ flexDirection: 'row', columnGap: 1, flexWrap: 'wrap', children: buttons })] : [])],
      }),
      ...(notice ? [Text({ color: 'red', wrap: 'wrap', children: [notice] })] : []),
      ...drawHealth($, e, doc),
      ...(doc.setup.running ? drawSetup($, e, doc) : []),
      ...doc.servers.map((s) => drawCard($, e, doc, s, pending[serverKey(s)] ?? pending['*'])),
    ],
  })
}

function drawHealth($, e, doc: WatchDoc) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const issues = doc.health?.issues ?? []
  if (issues.length === 0 || doc.setup.running) return []

  return [
    Box({
      key: 'health',
      flexDirection: 'column',
      borderStyle: 'round',
      paddingX: 1,
      children: [
        Text({ bold: true, color: 'red', children: ['Something failed'] }),
        ...issues.slice(0, 4).map((i, n) => Text({ key: 'issue-' + n, wrap: 'wrap', children: [cleanLine(issueLine(i))] })),
      ],
    }),
  ]
}

function drawSetup($, e, doc: WatchDoc) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const now = Date.now()

  return doc.setup.projects.map((p) => {
    const badge = setupBadge(p.state)

    return Box({
      key: 'setup-' + p.project,
      flexDirection: 'column',
      borderStyle: 'round',
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [Text({ bold: true, children: [p.project] }), Text({ color: TONE_COLOR[badge.tone], children: [badge.label] })],
        }),
        Text({ dimColor: true, wrap: 'wrap', children: [cleanLine(setupLine(p, now))] }),
        Button({ key: 'install-' + p.project, label: 'Install log', onPress: () => void openInstall($, p.project) }),
      ],
    })
  })
}

function drawCard($, e, doc: WatchDoc, s: ServerLine, pending?: Pending) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const state = cardState(s, pending)
  const key = serverKey(s)
  const second =
    !pending && isFailed(s)
      ? Text({ dimColor: true, wrap: 'wrap', children: [failureLine(s)] })
      : s.url && s.state !== 'stopped'
        ? Link({ href: s.url, label: s.url.replace(/^https?:\/\//, '') })
        : Text({ dimColor: true, children: [s.port ? 'port ' + s.port : 'no port'] })

  return Box({
    key: 'card-' + key,
    flexDirection: 'column',
    borderStyle: 'round',
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [Text({ bold: true, wrap: 'wrap', children: [s.server] }), Text({ color: TONE_COLOR[state.tone], children: [state.label] })],
      }),
      ...(isNameShared(doc, s) ? [Text({ dimColor: true, children: [s.project] })] : []),
      second,
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Button({ key: 'logs-' + key, label: 'Logs', onPress: () => void openLogs($, s) }),
          ...(canRestart(doc) ? [Button({ key: 'restart-' + key, label: 'Restart', onPress: () => void restartServer($, s) })] : []),
          ...(canFix(doc, s) ? [Button({ key: 'fix-' + key, label: 'Fix in Claude', onPress: () => void draftFix($, s) })] : []),
        ],
      }),
    ],
  })
}

function drawLogs($, e, view: { project: string; server: string }, doc: WatchDoc | null, lines: string[], pending: Record<string, Pending>) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const s = doc?.servers.find((o) => o.project === view.project && o.server === view.server)
  const state = s ? cardState(s, pending[serverKey(s)]) : null

  // A page's order: the way back, what this is, what can be done to it.
  return Box({
    flexDirection: 'column',
    children: [
      Button({ key: 'back', label: '‹ Back', plain: true, onPress: () => void backToList($) }),
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          Text({ bold: true, wrap: 'wrap', children: [view.server] }),
          ...(state ? [Text({ color: TONE_COLOR[state.tone], children: [state.label] })] : []),
        ],
      }),
      ...(s?.url && s.state !== 'stopped' ? [Link({ href: s.url, label: s.url.replace(/^https?:\/\//, '') })] : []),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          ...(s && canRestart(doc) ? [Button({ key: 'logs-restart', label: 'Restart', onPress: () => void restartServer($, s) })] : []),
          ...(s && canFix(doc, s) ? [Button({ key: 'logs-fix', label: 'Fix in Claude', onPress: () => void draftFix($, s) })] : []),
        ],
      }),
      ...drawLines($, e, lines),
    ],
  })
}

function drawInstall($, e, view: { project: string }, lines: string[]) {
  const { Box, Text, Button } = $.ui.resolve(e)

  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [Button({ key: 'back', label: '‹ Back', plain: true, onPress: () => void backToList($) })],
      }),
      Box({
        flexDirection: 'row',
        children: [Text({ bold: true, children: [view.project + ' setup'] })],
      }),
      ...drawLines($, e, lines),
    ],
  })
}

function drawLines($, e, lines: string[]) {
  const { Text } = $.ui.resolve(e)
  if (lines.length === 0) return [Text({ children: [' '] }), Text({ dimColor: true, children: ['No output yet'] })]

  return [Text({ children: [' '] }), ...lines.map((line, i) => Text({ key: 'l-' + i, wrap: 'truncate-end', dimColor: true, children: [line || ' '] }))]
}
