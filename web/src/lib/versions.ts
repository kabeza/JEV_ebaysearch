import type { JevAnswer, Judgment, Questionnaire } from './api'

/**
 * Which version's answers a view is showing.
 *
 * Every version's judgments arrive in one payload — a row's diff wants two
 * versions at once, so a per-version request would cost a request per comparison
 * — which means the separation has to happen here, once, before anything ranks
 * or renders them. `score.ts`'s `answersOf` keys answers by listing and
 * question, so two versions of the same answer handed to it together would
 * overwrite each other silently and the report would show a mixture of both.
 */

/**
 * Which version to show.
 *
 * A chosen version that is not in **this** run's list falls back to the newest,
 * and that is not a nicety: the choice is component state, so a selection made on
 * one run survives into the next, and filtering that run's judgments by a foreign
 * id returns none — every judged row would read "not judged yet" with no way back
 * except a reload.
 */
export function selectVersion(
  questionnaires: Questionnaire[],
  chosen: number | null,
): number | null {
  if (chosen !== null && questionnaires.some((q) => q.id === chosen)) return chosen
  const newest = [...questionnaires].sort((a, b) => b.version - a.version)[0]
  return newest?.id ?? null
}

export function judgmentsForVersion(judgments: Judgment[], questionnaireId: number): Judgment[] {
  return judgments.filter((j) => j.questionnaireId === questionnaireId)
}

/** The version just before the selected one, or null when there is not one. */
export function previousVersionOf(
  questionnaires: Questionnaire[],
  questionnaireId: number,
): Questionnaire | null {
  const ordered = [...questionnaires].sort((a, b) => a.version - b.version)
  const index = ordered.findIndex((q) => q.id === questionnaireId)
  if (index <= 0) return null
  return ordered[index - 1]!
}

/** Listing id → question key → answer, for a row's "was …" beside each answer. */
export function answersByListing(judgments: Judgment[]): Map<number, Record<string, JevAnswer>> {
  const out = new Map<number, Record<string, JevAnswer>>()
  for (const j of judgments) {
    const answers = out.get(j.listingId) ?? {}
    answers[j.questionKey] = j.answer
    out.set(j.listingId, answers)
  }
  return out
}
