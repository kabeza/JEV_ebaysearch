import type { Questionnaire } from '../lib/api'

/**
 * Which version of the questions the report is showing.
 *
 * One version means no selector at all: an ordinary run must not grow a control
 * that can only do one thing. Switching versions re-scores what is already on
 * the page, so it costs no request (spec §5.6, decision 4).
 */
export function VersionSelector({
  questionnaires,
  selected,
  onSelect,
}: {
  questionnaires: Questionnaire[]
  selected: number | null
  onSelect: (id: number) => void
}) {
  if (questionnaires.length < 2) return null
  const ordered = [...questionnaires].sort((a, b) => b.version - a.version)

  return (
    <label className="flex items-center gap-2 text-sm text-lilac-ash">
      questions
      <select
        aria-label="questionnaire version"
        value={selected ?? ''}
        onChange={(e) => onSelect(Number(e.target.value))}
        className="rounded border border-lilac-ash/40 bg-transparent px-1 py-0.5 text-almond-silk"
      >
        {ordered.map((q) => (
          <option key={q.id} value={q.id}>
            v{q.version} · {q.createdAt.slice(11, 16)}
          </option>
        ))}
      </select>
    </label>
  )
}
