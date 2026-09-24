import { useState } from 'react'
import { rejudge, type Questionnaire } from '../lib/api'
import {
  draftFromDefinition,
  validateDraft,
  type DraftQuestion,
  type QuestionnaireDraft,
} from '../../../src/jev/draft'
import type { SearchRequest } from '../../../src/jev/questions'

/**
 * The questions, editable, with the parts that must not move kept out of reach.
 *
 * The listing prefix and the buyer's own requirements are generated at build
 * time from the draft's request, so this form edits each question's wording and
 * its anchors and nothing else: an edit cannot leave a question unnamed, and it
 * cannot leave a quoted criterion stale (CLAUDE.md rules 16 and 17). A draft the
 * server refuses comes back with its reasons, shown verbatim.
 *
 * Prefilled from the selected version's stored definition, so editing continues
 * from what was actually asked; a version stored before Stage 7 has no question
 * text at all and opens on the shipped wording.
 */
export function QuestionEditor({
  runId,
  version,
  definition,
  fallbackRequest,
  onStarted,
  onClose,
}: {
  runId: number
  /** The version being edited from, for the heading. */
  version: number | null
  definition: Record<string, unknown> | null
  fallbackRequest: SearchRequest
  onStarted: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<QuestionnaireDraft>(() =>
    draftFromDefinition(definition, fallbackRequest),
  )
  const [reasons, setReasons] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const setRequest = (patch: Partial<SearchRequest>) =>
    setDraft((current) => ({ ...current, request: { ...current.request, ...patch } }))
  const setSpecField = (key: string, value: unknown) =>
    setDraft((current) => ({
      ...current,
      request: { ...current.request, spec: { ...current.request.spec, [key]: value } },
    }))
  const setQuestion = (key: string, patch: Partial<DraftQuestion>) =>
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((q) =>
        q.key === key ? ({ ...q, ...patch } as DraftQuestion) : q,
      ),
    }))

  const submit = async () => {
    // Checked here for an instant answer, and again on the server before it
    // spends anything: the two use the same function.
    const local = validateDraft(draft)
    setReasons(local)
    if (local.length > 0) return

    setBusy(true)
    setError(null)
    try {
      await rejudge(runId, draft as unknown as Record<string, unknown>)
      onStarted()
    } catch (e) {
      // A 400 lists what is wrong; a 409 says another job holds the lock.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full rounded border border-lilac-ash/40 bg-transparent px-2 py-1 text-almond-silk'
  const label = 'block text-xs text-lilac-ash'

  return (
    <section className="mb-4 rounded border border-almond-silk/40 bg-dusty-grape/20 p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm text-almond-silk">
          Edit the questions{' '}
          <span className="text-lilac-ash">
            {version === null ? '— starting from the shipped wording' : `— from v${version}`}
          </span>
        </h3>
        <button onClick={onClose} className="text-xs text-lilac-ash underline">
          close
        </button>
      </header>

      <p className="mb-3 text-xs text-lilac-ash/70">
        The listing’s facts and the buyer’s words are added by the app, not typed here: each question
        is prefixed with the listing it is about, and the criteria below are quoted into every
        question that needs them. Re-judging re-asks these questions about the listings already
        stored — no page is fetched.
      </p>

      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <label className={label}>
          the buyer’s criteria, verbatim
          <textarea
            aria-label="criteria text"
            value={draft.request.criteria_text}
            onChange={(e) => setRequest({ criteria_text: e.target.value })}
            rows={2}
            className={input}
          />
        </label>
        <label className={label}>
          budget, including shipping
          <input
            aria-label="max price"
            type="number"
            value={draft.request.max_price ?? ''}
            onChange={(e) =>
              setRequest({ max_price: e.target.value === '' ? undefined : Number(e.target.value) })
            }
            className={input}
          />
        </label>
        <label className={label}>
          accepted conditions, comma separated
          <input
            aria-label="accepted conditions"
            value={draft.request.accepted_conditions.join(', ')}
            onChange={(e) =>
              setRequest({
                accepted_conditions: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className={input}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            minimum RAM (GB)
            <input
              aria-label="spec ram gb"
              type="number"
              value={String(draft.request.spec.ram_gb ?? '')}
              onChange={(e) => setSpecField('ram_gb', e.target.value === '' ? undefined : Number(e.target.value))}
              className={input}
            />
          </label>
          <label className={label}>
            minimum storage (GB)
            <input
              aria-label="spec storage gb"
              type="number"
              value={String(draft.request.spec.storage_gb ?? '')}
              onChange={(e) =>
                setSpecField('storage_gb', e.target.value === '' ? undefined : Number(e.target.value))
              }
              className={input}
            />
          </label>
          <label className={label}>
            processor family
            <input
              aria-label="spec cpu family"
              value={String(draft.request.spec.cpu_family ?? '')}
              onChange={(e) => setSpecField('cpu_family', e.target.value)}
              className={input}
            />
          </label>
          <label className="flex items-end gap-2 text-xs text-lilac-ash">
            <input
              aria-label="spec touch"
              type="checkbox"
              checked={draft.request.spec.touch === true}
              onChange={(e) => setSpecField('touch', e.target.checked ? true : undefined)}
            />
            touchscreen required
          </label>
        </div>
      </div>

      <div className="space-y-4">
        {draft.questions.map((question) => (
          <div key={question.key} className="rounded border border-lilac-ash/20 p-3">
            <h4 className="mb-2 text-xs text-almond-silk">
              {question.key}{' '}
              <span className="text-lilac-ash">
                {question.kind === 'score' ? '— score' : '— yes or no'}
              </span>
            </h4>
            <label className={label}>
              the question
              <textarea
                aria-label={`instructions ${question.key}`}
                value={question.instructions}
                onChange={(e) => setQuestion(question.key, { instructions: e.target.value })}
                rows={3}
                className={input}
              />
            </label>
            {question.kind === 'noul' ? (
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <label className={label}>
                  what “yes” means
                  <input
                    aria-label={`anchor true ${question.key}`}
                    value={question.anchors.true}
                    onChange={(e) =>
                      setQuestion(question.key, {
                        anchors: { ...question.anchors, true: e.target.value },
                      })
                    }
                    className={input}
                  />
                </label>
                <label className={label}>
                  what “no” means
                  <input
                    aria-label={`anchor false ${question.key}`}
                    value={question.anchors.false}
                    onChange={(e) =>
                      setQuestion(question.key, {
                        anchors: { ...question.anchors, false: e.target.value },
                      })
                    }
                    className={input}
                  />
                </label>
              </div>
            ) : (
              <div className="mt-2 space-y-1">
                {question.levels.map((level, i) => (
                  <label key={i} className={label}>
                    level {i} — {i === 0 ? 'lowest' : i === question.levels.length - 1 ? 'highest' : ''}
                    <input
                      aria-label={`level ${i} ${question.key}`}
                      value={level}
                      onChange={(e) =>
                        setQuestion(question.key, {
                          levels: question.levels.map((l, j) => (j === i ? e.target.value : l)),
                        })
                      }
                      className={input}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-almond-silk">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {error && <p className="mt-3 text-sm text-almond-silk">Error: {error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Re-judge with these'}
        </button>
        <span className="text-xs text-lilac-ash/70">
          Creates a new question version. The answers already stored stay.
        </span>
      </div>
    </section>
  )
}
