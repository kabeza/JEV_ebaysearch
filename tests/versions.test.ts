import { describe, it, expect } from 'vitest'
import {
  answersByListing,
  judgmentsForVersion,
  previousVersionOf,
  selectVersion,
} from '../web/src/lib/versions'
import type { Judgment, Questionnaire } from '../web/src/lib/api'

const questionnaires: Questionnaire[] = [
  { id: 10, version: 1, createdAt: '2026-09-24 09:00', definition: {} },
  { id: 11, version: 2, createdAt: '2026-09-24 09:10', definition: {} },
]

const judgment = (id: number, questionnaireId: number, listingId: number, noul: number): Judgment => ({
  id,
  questionnaireId,
  listingId,
  questionKey: 'condition_ok',
  answer: { type: 'noul', noul },
})

const judgments = [
  judgment(1, 10, 5, 0.9),
  judgment(2, 11, 5, 0.2),
  judgment(3, 10, 6, 0.8),
]

describe('judgmentsForVersion', () => {
  it('keeps one version, so two answers for one listing cannot overwrite each other', () => {
    expect(judgmentsForVersion(judgments, 10).map((j) => j.id)).toEqual([1, 3])
    expect(judgmentsForVersion(judgments, 11).map((j) => j.id)).toEqual([2])
  })

  it('returns nothing for a version that has no answers yet', () => {
    expect(judgmentsForVersion(judgments, 99)).toEqual([])
  })
})

describe('previousVersionOf', () => {
  it('names the version before the selected one', () => {
    expect(previousVersionOf(questionnaires, 11)?.id).toBe(10)
  })

  it('has no previous version for the first one', () => {
    expect(previousVersionOf(questionnaires, 10)).toBeNull()
  })

  it('is null for a version id that is not in the list', () => {
    expect(previousVersionOf(questionnaires, 99)).toBeNull()
  })

  it('does not depend on the list arriving in order', () => {
    expect(previousVersionOf([...questionnaires].reverse(), 11)?.id).toBe(10)
  })
})

describe('answersByListing', () => {
  it('indexes answers by listing, then by question, so a row can diff itself', () => {
    const map = answersByListing(judgmentsForVersion(judgments, 10))
    expect(map.get(5)?.condition_ok).toEqual({ type: 'noul', noul: 0.9 })
    expect(map.get(6)?.condition_ok).toEqual({ type: 'noul', noul: 0.8 })
    expect(map.get(7)).toBeUndefined()
  })
})

describe('selectVersion', () => {
  it('shows the chosen version when this run has it', () => {
    expect(selectVersion(questionnaires, 10)).toBe(10)
  })

  it('falls back to the newest when the chosen version belongs to another run', () => {
    // The bug this exists for: a selection made on run A survives into run B,
    // whose judgments have no such version — so every judged row filtered to
    // nothing and the table called all of them "not judged yet".
    expect(selectVersion(questionnaires, 999)).toBe(11)
  })

  it('has nothing to show without versions, and nothing chosen at all', () => {
    expect(selectVersion([], 10)).toBeNull()
    expect(selectVersion(questionnaires, null)).toBe(11)
  })

  it('does not depend on the list arriving in order', () => {
    expect(selectVersion([...questionnaires].reverse(), null)).toBe(11)
  })
})
