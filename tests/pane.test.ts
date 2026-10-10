import { expect, mock, test } from 'claude-code/testing'
import { crewArgv, devWatchRunning, devWatchStopped, which } from './goldens.ts'

const CWD = '/w/store-front/main/store-api'

function pane(surface: 'terminal' | 'desktop') {
  return {
    plugin: 'crew', component: 'Pane', requestId: 'crew', surface,
    viewport: { columns: 160, rows: 40 },
    props: { title: 'crew store-front/main', isFocused: true, bodyColumns: 34, placement: 'dock', scroll: { offset: 0, bodyRows: 38 }, view: {} },
  } as const
}

type Calls = { run: string[][]; spawn: string[][]; filled: string[]; toasts: string[]; opened: number; paths: string[] }

// Stubs crew the way the Go goldens say it answers.
function stubCrew(on, calls: Calls, opts: { onceDoc?: unknown; doc?: unknown; whichExit?: number; whichStderr?: string; fix?: string; fixExit?: number; restartExit?: number; crewRef?: string; noCrewOnPath?: boolean } = {}) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => {
    calls.opened += 1
    return { value: { isPlaced: true } }
  })
  on('ui.toast', ($, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/Users/dev' : e.name === 'CREW_REF' ? opts.crewRef : e.name === 'PATH' ? '/usr/bin:/bin' : undefined }))
  on('process.run', ($, e) => {
    if (opts.noCrewOnPath && e.argv[0] === 'crew') return { deny: 'crew: command not found' }
    calls.run.push([...e.argv])
    calls.paths.push(e.init?.env?.PATH ?? '')
    const [, verb, sub] = e.argv
    if (verb === 'which') {
      return { value: { exitCode: opts.whichExit ?? 0, stdout: opts.whichExit ? '' : JSON.stringify(which), stderr: opts.whichStderr ?? '' } }
    }
    if (verb === 'fix') return { value: { exitCode: opts.fixExit ?? 0, stdout: opts.fixExit ? '' : opts.fix ?? 'Fix the worktree.\n', stderr: opts.fixExit ? 'Error: nothing recorded\n' : '' } }
    if (verb === 'setup' && sub === 'logs') return { value: { exitCode: 0, stdout: JSON.stringify({ lines: ['\x1b[33m▸ pnpm install\x1b[0m', 'Progress:\tresolved 412', 'done\r'] }), stderr: '' } }
    if (verb === 'dev' && sub === 'watch') return { value: { exitCode: 0, stdout: JSON.stringify(opts.onceDoc ?? opts.doc ?? devWatchRunning) + '\n', stderr: '' } }
    if (verb === 'dev' && sub === 'logs') return { value: { exitCode: 0, stdout: JSON.stringify({ lines: ['\x1b[32mready\x1b[0m on :54010', 'GET / 200'] }), stderr: '' } }
    if (verb === 'start') return { value: { exitCode: 0, stdout: '# store-front/main\nThe projects…\n', stderr: '' } }
    if (verb === 'dev' && sub === 'restart') return { value: { exitCode: opts.restartExit ?? 0, stdout: '', stderr: opts.restartExit ? 'Error: port 54012 is still in use after stopping store-api/api — something else holds it\n' : '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('process.spawn', async function* ($, e) {
    calls.spawn.push([...e.argv])
    calls.paths.push(e.env?.PATH ?? '')
    if (e.argv[1] === 'dev' && e.argv[2] === 'watch') {
      yield { stream: 'stdout', text: JSON.stringify(opts.doc ?? devWatchRunning) + '\n' }
    }
    if (e.argv[1] === 'dev' && e.argv[2] === 'logs') {
      yield { stream: 'stdout', text: '\x1b[32mready\x1b[0m on :54010\r\nGET / 200\r\n' }
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.fill', ($, e) => {
    calls.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))

  return clock
}

function newCalls(): Calls {
  return { run: [], spawn: [], filled: [], toasts: [], opened: 0, paths: [] }
}

test('a worktree session opens the pane and draws a card per declared server', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  expect(calls.run[0]).toEqual(['crew', 'which', CWD, '--json'])

  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ type: 'Text', text: '2 of 4 running' })).toBeDefined()
  expect(await ui.find({ key: 'logs-store-front/web' })).toBeDefined()
  expect(await ui.find({ key: 'fix-store-api/api' })).toBeDefined()
  expect(await ui.find({ key: 'fix-store-front/web' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Stopped' })).toBeDefined()
  expect(calls.spawn[0]).toEqual(['crew', 'dev', 'watch', 'store-front/main', '--json'])
})

test('the terminal draws the same pane', async ($, on) => {
  stubCrew(on, newCalls())
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: '2 of 4 running' })).toBeDefined()
  expect(await ui.find({ key: 'restart-all' })).toBeDefined()
})

test('in the terminal, Logs follows the server log inline, cleaned, and Back returns to the list', async ($, on) => {
  const calls = newCalls()
  const clock = stubCrew(on, calls)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'logs-store-front/web' })
  await clock.advance(1000)

  expect(calls.spawn).toContainEqual(['crew', 'dev', 'logs', 'store-front/main', 'store-front/web', '-f'])
  expect(await ui.find({ type: 'Text', text: 'ready on :54010' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /[\x00-\x1f\x7f]/ })).toBeUndefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: '2 of 4 running' })).toBeDefined()
})

test('Restart runs crew for that one server', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'restart-store-front/web' })
  expect(calls.run).toContainEqual(['crew', 'dev', 'restart', 'store-front/main', 'store-front/web'])
})

test('a refused restart shows crew\'s own line', async ($, on) => {
  stubCrew(on, newCalls(), { restartExit: 1 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'restart-store-api/api' })
  expect(await ui.find({ type: 'Text', text: /port 54012 is still in use/ })).toBeDefined()
})

test('Fix in Claude drafts crew fix --print into the prompt box, never sends', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { fix: 'Fix store-front/main: store-api/api died.\n' })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'fix-store-api/api' })
  expect(calls.run).toContainEqual(['crew', 'fix', 'store-front/main', '--print'])
  expect(calls.filled).toEqual(['Start with store-api/api in store-front/main — it died.\n\nFix store-front/main: store-api/api died.'])
})

test('nothing running offers Start all and no per-server restart', async ($, on) => {
  const stopped = { ...devWatchStopped, setup: { running: false, failed: false, projects: [] } }
  stubCrew(on, newCalls(), { doc: stopped })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ key: 'start-all' })).toBeDefined()
  expect(await ui.find({ key: 'restart-store-front/web' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Not running' })).toBeDefined()
})

test('while setup runs, the pane shows each project and offers no start', async ($, on) => {
  stubCrew(on, newCalls(), { doc: devWatchStopped })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ key: 'install-store-api' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Setting up' })).toBeDefined()
  expect(await ui.find({ key: 'start-all' })).toBeUndefined()
})

test('a folder outside crew gets nothing: no pane, no watch', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { whichExit: 1, whichStderr: '/tmp is not in a crew worktree' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp' })
  expect(calls.opened).toBe(0)
  expect(calls.spawn).toEqual([])
  expect(calls.toasts).toEqual([])
})

test('an older crew says so once and draws nothing', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { whichExit: 1, whichStderr: "Unknown command 'which'. Run 'crew help' for usage." })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  expect(calls.toasts).toEqual(['crew is older than its Claude pane — run crew update'])
  expect(calls.spawn).toEqual([])
})

test('a session nobody draws for (Voice OS, claude -p) never watches', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: null, isInteractive: false, cwd: CWD })
  expect(calls.spawn).toEqual([])
})

test('Desktop starts sessions non-interactive with no surface; they still get the pane', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: null, isInteractive: false, cwd: CWD })
  expect(calls.opened).toBe(1)
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ type: 'Text', text: '2 of 4 running' })).toBeDefined()
})

test('a CREW_REF from another worktree does not decide the pane', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { crewRef: 'crew/research' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  expect(calls.run[0]).toEqual(['crew', 'which', CWD, '--json'])
  expect(calls.spawn).toEqual([])
  const result = await $.prompt.context({ blocks: [] })
  expect(result.blocks.map((b) => b.name)).toEqual(['crew'])
})

test('a session crew did not launch gets crew\'s orientation, asked of crew once', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const result = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
  expect(result.blocks.map((b) => b.name)).toEqual(['currentDate', 'crew'])
  const again = await $.prompt.context({ blocks: [] })
  expect(again.blocks.map((b) => b.name)).toEqual(['crew'])
  expect(calls.run.filter((a) => a[1] === 'start').length).toBe(1)
})

test('a session crew launched (CREW_REF set) is left as it is', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { crewRef: 'store-front/main' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  const result = await $.prompt.context({ blocks: [] })
  expect(result.blocks).toEqual([])
})

// Every command the pane runs is one crew's help tree documents
// (crew-argv.json, walked by a Go test): nothing here may call anything else.
test('the pane only runs the crew commands the contract lists', async ($, on) => {
  const calls = newCalls()
  const clock = stubCrew(on, calls)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w/store-front/main/store-api' })
  await $.prompt.context({ blocks: [] })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'restart-store-front/web' })
  await ui.press({ key: 'fix-store-api/api' })
  await ui.press({ key: 'restart-all' })
  await ui.press({ key: 'logs-store-front/web' })
  await clock.advance(1000)

  const known = new Set(crewArgv.map((a) => a.join(' ')))
  for (const argv of [...calls.run, ...calls.spawn]) {
    expect(known.has(argv.slice(1).join(' '))).toBe(true)
  }
})

test('the install log is cleaned before it is drawn', async ($, on) => {
  const clock = stubCrew(on, newCalls(), { doc: devWatchStopped })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'install-store-api' })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: '▸ pnpm install' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /[\x00-\x1f\x7f]/ })).toBeUndefined()
})

test('crew off PATH is found in ~/.local/bin and used from then on', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { noCrewOnPath: true })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  await $.ui.mount(pane('desktop'))
  expect(calls.run[0]).toEqual(['/Users/dev/.local/bin/crew', 'which', CWD, '--json'])
  expect(calls.spawn[0][0]).toBe('/Users/dev/.local/bin/crew')
})

test('restarting the server on screen follows its new log', async ($, on) => {
  const calls = newCalls()
  const clock = stubCrew(on, calls)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'logs-store-front/web' })
  await ui.press({ key: 'logs-restart' })
  await clock.advance(1000)
  const follows = calls.spawn.filter((a) => a[2] === 'logs')
  expect(follows.length).toBe(2)
})

test('a Fix with nothing to say tells you instead of filling the box', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { fixExit: 1 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'fix-store-api/api' })
  expect(calls.filled).toEqual([])
  expect(calls.toasts).toEqual(['crew fix had nothing to say — nothing recorded'])
})

// Desktop's log follows live too, redrawn at most every two seconds; Back
// takes focus and returning focuses the Logs button it came from.
test('in Desktop, Logs follows the log and Back returns to the list', async ($, on) => {
  const calls = newCalls()
  const clock = stubCrew(on, calls)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'logs-store-front/web' })
  await clock.advance(2000)
  expect(calls.spawn).toContainEqual(['crew', 'dev', 'logs', 'store-front/main', 'store-front/web', '-f'])
  expect(await ui.find({ type: 'Text', text: 'ready on :54010' })).toBeDefined()
  // Focus moves are $.ui.focus calls the kit answers itself; the live
  // terminal QA checks where focus lands.
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'logs-store-front/web' })).toBeDefined()
})

test('a worktree with no dev servers gets no pane', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls, { onceDoc: { ...devWatchStopped, servers: [] } })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  expect(calls.opened).toBe(0)
})

// Desktop's bare PATH hides tmux, and crew then calls every server dead.
test('every crew command runs with Homebrew and ~/.local/bin on its PATH', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: null, isInteractive: false, cwd: CWD })
  await $.ui.mount(pane('desktop'))
  expect(calls.paths.length > 0).toBe(true)
  for (const path of calls.paths) expect(path).toBe('/Users/dev/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
})

test('Fix in Claude sits with the worktree actions only when something failed', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ key: 'fix-all' })).toBeDefined()
  await ui.press({ key: 'fix-all' })
  expect(calls.filled).toEqual(['Fix the worktree.'])
})

test('a healthy worktree offers no Fix in Claude', async ($, on) => {
  const healthy = { ...devWatchRunning, health: null, servers: devWatchRunning.servers.map((s) => ({ ...s, state: 'up', tail: undefined })) }
  stubCrew(on, newCalls(), { doc: healthy })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ key: 'fix-all' })).toBeUndefined()
  expect(await ui.find({ key: 'restart-all' })).toBeDefined()
})

test('the proxy switch restarts the worktree in the other mode', async ($, on) => {
  const calls = newCalls()
  stubCrew(on, calls)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ type: 'Button', text: 'Proxy: off' }) ?? await ui.find({ key: 'proxy' })).toBeDefined()
  await ui.press({ key: 'proxy' })
  expect(calls.run).toContainEqual(['crew', 'dev', 'restart', 'store-front/main', '--proxy'])
})

test('the log page links the server', async ($, on) => {
  stubCrew(on, newCalls())
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: CWD })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'logs-store-front/web' })
  expect(await ui.find({ type: 'Link' })).toBeDefined()
})
