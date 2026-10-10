import { expect, test } from 'claude-code/testing'
import { devWatchRunning as running, devWatchStopped as stopped, which } from './goldens.ts'
import {
  appendLines,
  canFix,
  cardState,
  cleanLine,
  failureLine,
  fixDraft,
  canRestart,
  headerActions,
  isCrewTooOld,
  isNameShared,
  lastLine,
  setupBadge,
  withToolDirs,
  parseWatchLine,
  parseWhich,
  setupLine,
  splitChunk,
  summary,
  type WatchDoc,
} from '../hooks/model.ts'

const runningDoc = running as unknown as WatchDoc
const stoppedDoc = stopped as unknown as WatchDoc

test('cleanLine strips colour, hyperlinks, redraws and control characters', async () => {
  expect(cleanLine('\x1b[32mready\x1b[0m on :3000')).toBe('ready on :3000')
  expect(cleanLine('see \x1b]8;;http://x.test\x07the docs\x1b]8;;\x07 now')).toBe('see the docs now')
  expect(cleanLine('progress 10%\rprogress 90%')).toBe('progress 90%')
  expect(cleanLine('> tsx --watch src/server.ts\r')).toBe('> tsx --watch src/server.ts')
  expect(cleanLine('10%\r90%\r\r')).toBe('90%')
  expect(cleanLine('a\tb\x07c\x00d')).toBe('a  bcd')
})

test('tmux CRLF log lines keep their text', async () => {
  expect(splitChunk('', 'ready on :3000\r\nGET / 200\r\n').lines).toEqual(['ready on :3000', 'GET / 200'])
})

test('splitChunk carries a partial line to the next chunk', async () => {
  const first = splitChunk('', 'one\ntw')
  expect(first.lines).toEqual(['one'])
  const second = splitChunk(first.carry, 'o\nthree\n')
  expect(second.lines).toEqual(['two', 'three'])
  expect(second.carry).toBe('')
})

test('appendLines keeps the last 200', async () => {
  const burst = Array.from({ length: 500 }, (_, i) => 'line ' + i)
  const kept = appendLines(['old'], burst)
  expect(kept.length).toBe(200)
  expect(kept[199]).toBe('line 499')
})

test('the Go-written watch documents parse', async () => {
  expect(parseWatchLine(JSON.stringify(runningDoc))?.servers.length).toBe(4)
  expect(parseWatchLine('not json')).toBe(null)
  expect(parseWatchLine('{"ref":"x"}')).toBe(null)
  expect(parseWhich(JSON.stringify(which))?.ref).toBe('store-front/main')
})

test('card states read crew\'s words', async () => {
  const [web, api, worker, rtc] = runningDoc.servers
  expect(cardState(web)).toEqual({ label: 'Running', tone: 'good' })
  expect(cardState(api)).toEqual({ label: 'Died', tone: 'bad' })
  expect(cardState(worker)).toEqual({ label: 'Running', tone: 'good' })
  expect(cardState(rtc)).toEqual({ label: 'Stopped', tone: 'idle' })
  expect(cardState(web, 'restarting')).toEqual({ label: 'Restarting', tone: 'busy' })
  expect(failureLine(api)).toBe("Error: Cannot find module 'express'")
})

test('summary counts what runs', async () => {
  expect(summary(runningDoc)).toBe('2 of 4 running')
  expect(summary(stoppedDoc)).toBe('Not running')
})

test('Fix in Claude is offered only where crew has evidence', async () => {
  const [web, api] = runningDoc.servers
  expect(canFix(runningDoc)).toBe(true)
  expect(canFix(runningDoc, api)).toBe(true)
  expect(canFix(runningDoc, web)).toBe(false)
  expect(canFix(stoppedDoc)).toBe(false)
  expect(canFix(null)).toBe(false)
  expect(fixDraft('  The prompt.\n', 'store-front/main', api)).toBe('Start with store-api/api in store-front/main — it died.\n\nThe prompt.')
})

test('a setup row names its running step and how long it has taken', async () => {
  const api = stoppedDoc.setup.projects[1]
  const started = Date.parse(api.steps[1].started_at!)
  expect(setupLine(api, started + 72_000)).toBe('pnpm install 1m12s')
  expect(setupLine(stoppedDoc.setup.projects[0], 0)).toBe('checkout 1s')
})

test('an older crew is told apart from a folder outside crew', async () => {
  expect(isCrewTooOld("Unknown command 'which'. Run 'crew help' for usage.")).toBe(true)
  expect(isCrewTooOld('/tmp is not in a crew worktree')).toBe(false)
})

test('restart is offered only when it can work', async () => {
  expect(canRestart(runningDoc)).toBe(true)
  expect(canRestart({ ...runningDoc, setup: { ...runningDoc.setup, running: true } })).toBe(false)
  expect(canRestart(stoppedDoc)).toBe(false)
  expect(canRestart(null)).toBe(false)
})

test('the header offers what fits the worktree', async () => {
  expect(headerActions(runningDoc)).toBe('running')
  expect(headerActions(stoppedDoc)).toBe('none')
  expect(headerActions({ ...stoppedDoc, setup: { running: false, failed: false, projects: [] } })).toBe('stopped')
  expect(headerActions({ ...runningDoc, servers: [] })).toBe('none')
})

test('setup badges pair label and colour', async () => {
  expect(setupBadge('ok')).toEqual({ label: 'Ready', tone: 'good' })
  expect(setupBadge('running')).toEqual({ label: 'Setting up', tone: 'busy' })
  expect(setupBadge('starting')).toEqual({ label: 'Setting up', tone: 'busy' })
  expect(setupBadge('failed')).toEqual({ label: 'Failed', tone: 'bad' })
  expect(setupBadge('interrupted')).toEqual({ label: 'Failed', tone: 'bad' })
})

test('a shared server name and the last stderr line', async () => {
  const doc = { ...runningDoc, servers: [runningDoc.servers[0], { ...runningDoc.servers[0], project: 'store-api' }] }
  expect(isNameShared(doc, doc.servers[0])).toBe(true)
  expect(isNameShared(runningDoc, runningDoc.servers[0])).toBe(false)
  expect(lastLine('warning: x\nError: port 54012 is still in use\n')).toBe('port 54012 is still in use')
})

test('a bare Desktop PATH gets the folders crew and tmux live in', async () => {
  expect(withToolDirs('/usr/bin:/bin', '/Users/dev')).toBe('/Users/dev/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
  expect(withToolDirs('/opt/homebrew/bin:/usr/bin', '/Users/dev')).toBe('/Users/dev/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin')
  expect(withToolDirs(undefined, undefined)).toBe('/opt/homebrew/bin:/usr/local/bin')
})
