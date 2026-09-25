import type { RunStatus } from '../storage/runs'
import type { RunEventType } from '../storage/events'

/**
 * The pause signal: how a run that cannot make progress waits for a person.
 *
 * Two things reach it, and only two — a bot challenge on a results page, and a
 * JEV outage the SDK's retries did not survive (spec §11). Both are states a
 * machine cannot fix by trying harder: the first needs a human in the visible
 * browser, the second needs the service to come back. So the run waits, says why,
 * and continues from the same page or batch when it is resumed (spec §3).
 *
 * It is a value rather than module state so that a test can hold one directly,
 * and it exposes exactly two ways out: `resume` (a person said continue) and
 * `release` (a cancel, which must not be called a resume — the run is about to
 * end). A cancelled pause that never released would hold the one-job lock
 * forever, which is the failure mode this shape exists to prevent.
 */

export interface PauseDetail {
  reason: 'bot_challenge' | 'jev_outage'
  /** What was in flight, in the run's own terms. */
  page?: number
  batch?: number
  /** A challenge page's title: it is what makes a challenge recognisable. */
  title?: string
  status?: number
  screenshot?: string
  message: string
}

export interface Pause {
  wait(detail: PauseDetail): Promise<void>
  resume(): boolean
  /** Wakes a waiting run without recording a resume — the cancel path. */
  release(): void
  isPaused(): boolean
  detail(): PauseDetail | null
}

export interface PauseOptions {
  /** How the run's status is written; the runner supplies `updateRunStatus`. */
  setStatus: (status: RunStatus) => void
  emit: (type: RunEventType, payload: unknown) => void
}

export function createPause(o: PauseOptions): Pause {
  let current: PauseDetail | null = null
  let release: (() => void) | null = null

  return {
    wait(detail) {
      current = detail
      o.setStatus('paused')
      o.emit('run.paused', detail)

      return new Promise<void>((resolve) => {
        release = () => {
          current = null
          release = null
          resolve()
        }
      })
    },

    resume() {
      if (!current || !release) return false
      o.setStatus('running')
      o.emit('run.resumed', { reason: current.reason })
      release()
      return true
    },

    release() {
      release?.()
    },

    isPaused() {
      return current !== null
    },

    detail() {
      return current
    },
  }
}
