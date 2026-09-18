import { useEffect, useState } from 'react'
import { createSearch, listSearches, startRun, type Search } from './lib/api'
import RunView from './components/RunView'

export default function App() {
  const [searches, setSearches] = useState<Search[]>([])
  const [name, setName] = useState('')
  const [keyword, setKeyword] = useState('')
  const [criteriaText, setCriteriaText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<number | null>(null)

  async function refresh() {
    try {
      setSearches(await listSearches())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await createSearch({ name, keyword, criteriaText })
      setName('')
      setKeyword('')
      setCriteriaText('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-6 md:grid-cols-2">
      <section>
        <h1 className="mb-6 text-2xl font-semibold text-almond-silk">jevbrowser</h1>
        <form onSubmit={onSubmit} className="space-y-4 rounded-lg bg-dusty-grape/40 p-5">
          <label className="block">
            <span className="text-sm text-lilac-ash">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-lilac-ash/40 bg-space-indigo p-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-lilac-ash">Keyword</span>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Thinkpad T14s gen 6"
              className="mt-1 w-full rounded border border-lilac-ash/40 bg-space-indigo p-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-lilac-ash">Criteria</span>
            <textarea
              value={criteriaText}
              onChange={(e) => setCriteriaText(e.target.value)}
              rows={4}
              placeholder="32gb ram, Ryzen, 1tb, touch screen, under u$s 1600"
              className="mt-1 w-full rounded border border-lilac-ash/40 bg-space-indigo p-2"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-almond-silk px-4 py-2 font-medium text-space-indigo disabled:opacity-40"
            disabled={!name.trim() || !keyword.trim()}
          >
            Save search
          </button>
          {error && <p className="text-sm text-almond-silk">Error: {error}</p>}
        </form>
      </section>

      <section>
        <h2 className="mb-4 text-lg text-lilac-ash">Saved searches</h2>
        {searches.length === 0 ? (
          <p className="text-lilac-ash/70">Nothing saved yet.</p>
        ) : (
          <ul className="space-y-3">
            {searches.map((s) => (
              <li key={s.id} className="rounded border border-lilac-ash/30 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-almond-silk">{s.name}</p>
                    <p className="text-sm text-lilac-ash">{s.keyword}</p>
                  </div>
                  <button
                    onClick={async () => {
                      setError(null)
                      try {
                        const { runId: id } = await startRun(s.id)
                        setRunId(id)
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err))
                      }
                    }}
                    className="rounded bg-almond-silk px-3 py-1.5 text-sm font-medium text-space-indigo"
                  >
                    Run search
                  </button>
                </div>
                {s.criteriaText && (
                  <p className="mt-2 text-sm text-lilac-ash/80">{s.criteriaText}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {runId !== null && <RunView runId={runId} onClose={() => setRunId(null)} />}
    </main>
  )
}
