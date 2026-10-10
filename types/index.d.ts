// The crew pane's state, in $.state so a write redraws only what reads it.
// Self-contained by rule: the shapes mirror hooks/model.ts.

export type CrewServerState = 'up' | 'starting' | 'unreached' | 'quiet' | 'died' | 'stopped'

export type CrewServerLine = { project: string; server: string; port: number; url: string; state: CrewServerState; tail?: string }

export type CrewSetupProject = { project: string; state: string; steps: { name: string; status: string; started_at?: string; took_ms?: number; detail?: string }[] }

export type CrewIssue = { stage: string; project?: string; server?: string; reason?: string; detail?: string }

export type CrewWatchDoc = {
  ref: string
  running: boolean
  proxied: boolean
  servers: CrewServerLine[]
  setup: { running: boolean; failed: boolean; projects: CrewSetupProject[] }
  health: { at: string; issues: CrewIssue[] } | null
}

export type CrewView = { kind: 'list' } | { kind: 'logs'; project: string; server: string } | { kind: 'install'; project: string }

export type CrewPending = 'restarting' | 'starting' | 'stopping'

declare module 'claude-code' {
  interface PluginState {
    crew: {
      doc: CrewWatchDoc | null
      view: CrewView
      log: string[]
      pending: Record<string, CrewPending>
      notice: string
    }
  }
}
