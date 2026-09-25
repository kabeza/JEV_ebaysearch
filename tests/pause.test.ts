import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun, updateRunStatus } from '../src/storage/runs'
import { appendEvent, listEvents } from '../src/storage/events'
import { createPause } from '../src/pipeline/pause'

/**
 * The pause signal on its own, as a value rather than module state: a run that
 * cannot make progress waits for a person, and the only two ways out are a resume
 * and a cancel. A timeout would be a third way, and a paused run holds the
 * one-job lock, so the cancel path is what keeps it from being a deadlock.
 */
function fixture() {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 's', keyword: 'k', criteriaText: 'c', spec: {} })
  const run = createRun(db, search.id, {})
  const emit = (type: Parameters<typeof appendEvent>[2], payload: unknown) =>
    appendEvent(db, run.id, type, payload)
  const pause = createPause({
    setStatus: (status) => updateRunStatus(db, run.id, status),
    emit,
  })
  return { db, runId: run.id, pause }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the pause signal', () => {
  it('holds a run until it is resumed, and records why it waited', async () => {
    const { db, runId, pause } = fixture()
    let woke = false
    const waiting = pause
      .wait({
        reason: 'bot_challenge',
        page: 2,
        title: 'Pardon Our Interruption',
        status: 503,
        message: 'eBay returned HTTP 503 on page 2',
      })
      .then(() => {
        woke = true
      })

    // Still waiting until someone says otherwise.
    await sleep(20)
    expect(woke).toBe(false)
    expect(pause.isPaused()).toBe(true)
    expect(getRun(db, runId)?.status).toBe('paused')
    const paused = listEvents(db, runId).find((e) => e.type === 'run.paused')
    expect(paused?.payload).toMatchObject({ reason: 'bot_challenge', page: 2, status: 503 })

    expect(pause.resume()).toBe(true)
    await waiting
    expect(woke).toBe(true)
    expect(pause.isPaused()).toBe(false)
    expect(getRun(db, runId)?.status).toBe('running')
    expect(listEvents(db, runId).map((e) => e.type)).toContain('run.resumed')
  })

  it('refuses to resume something that is not paused, so a stray click changes nothing', () => {
    const { db, runId, pause } = fixture()
    expect(pause.resume()).toBe(false)
    expect(getRun(db, runId)?.status).toBe('running')
  })

  it('wakes a cancelled run without calling it a resume', async () => {
    // A cancel while paused is the way out. It must release the wait, or the run
    // stays paused forever holding the lock and no other run can start.
    const { db, runId, pause } = fixture()
    let woke = false
    const waiting = pause.wait({ reason: 'jev_outage', message: 'overloaded' }).then(() => {
      woke = true
    })

    await sleep(20)
    pause.release()
    await waiting

    expect(woke).toBe(true)
    expect(pause.isPaused()).toBe(false)
    // Released, not resumed: the run's status is the caller's business, and a
    // cancelled run is about to be finished as `cancelled`.
    expect(getRun(db, runId)?.status).toBe('paused')
    expect(listEvents(db, runId).map((e) => e.type)).not.toContain('run.resumed')
  })

  it('pauses again if it is asked to, so a repeated challenge is a second pause', async () => {
    const { db, runId, pause } = fixture()
    const first = pause.wait({ reason: 'bot_challenge', page: 2, message: 'challenged' })
    await sleep(10)
    pause.resume()
    await first

    const second = pause.wait({ reason: 'bot_challenge', page: 2, message: 'challenged again' })
    await sleep(10)
    expect(pause.isPaused()).toBe(true)
    pause.resume()
    await second

    expect(listEvents(db, runId).filter((e) => e.type === 'run.paused')).toHaveLength(2)
    expect(listEvents(db, runId).filter((e) => e.type === 'run.resumed')).toHaveLength(2)
  })
})
