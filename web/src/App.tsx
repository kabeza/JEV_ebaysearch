import { useEffect, useState } from 'react'
import { createSearch, listSearches, startRun, type Search } from './lib/api'
import { EMPTY_SPEC_FORM, specFromForm, summariseSpec, type SpecFormValues } from './lib/spec'
import RunView from './components/RunView'

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <label className="block">
      <span className="text-sm text-lilac-ash">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded border border-lilac-ash/40 bg-space-indigo p-2"
      />
    </label>
  )
}

export default function App() {
  const [searches, setSearches] = useState<Search[]>([])
  const [name, setName] = useState('')
  const [keyword, setKeyword] = useState('')
  const [criteriaText, setCriteriaText] = useState('')
  const [specForm, setSpecForm] = useState<SpecFormValues>(EMPTY_SPEC_FORM)
  const [error, setError] = useState<string | null>(null)
  // The whole search, not just its spec: the question editor edits the buyer's
  // criteria, so it needs the keyword and the criteria text as well.
  const [activeRun, setActiveRun] = useState<Search | null>(null)

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
      await createSearch({ name, keyword, criteriaText, spec: specFromForm(specForm) })
      setName('')
      setKeyword('')
      setCriteriaText('')
      setSpecForm(EMPTY_SPEC_FORM)
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

          {/*
            These are the requirements the code pre-filter applies before any
            listing is worth a page visit or a JEV call. Blank means no
            requirement — a card is then never rejected on that field.
          */}
          <fieldset className="space-y-3 rounded border border-lilac-ash/30 p-3">
            <legend className="px-1 text-sm text-lilac-ash">Requirements (optional)</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Max price (USD)"
                value={specForm.maxPrice}
                onChange={(v) => setSpecForm({ ...specForm, maxPrice: v })}
                placeholder="1600"
              />
              <Field
                label="Min RAM (GB)"
                value={specForm.ramGb}
                onChange={(v) => setSpecForm({ ...specForm, ramGb: v })}
                placeholder="32"
              />
              <Field
                label="Min storage (GB)"
                value={specForm.storageGb}
                onChange={(v) => setSpecForm({ ...specForm, storageGb: v })}
                placeholder="1000"
              />
              <Field
                label="CPU family"
                value={specForm.cpuFamily}
                onChange={(v) => setSpecForm({ ...specForm, cpuFamily: v })}
                placeholder="AMD Ryzen"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-lilac-ash">
              <input
                type="checkbox"
                checked={specForm.touch}
                onChange={(e) => setSpecForm({ ...specForm, touch: e.target.checked })}
              />
              Touchscreen required
            </label>
          </fieldset>

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
            {searches.map((s) => {
              const requirements = summariseSpec(s.spec ?? {})
              return (
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
                          const { runId } = await startRun(s.id)
                          setActiveRun({ ...s, id: runId })
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
                  <p className="mt-2 text-sm">
                    {requirements ? (
                      <span className="text-lilac-ash/80">Pre-filter: {requirements}</span>
                    ) : (
                      <span className="text-lilac-ash/50">
                        No requirements set — nothing will be pre-filtered
                      </span>
                    )}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {activeRun !== null && (
        <RunView runId={activeRun.id} search={activeRun} onClose={() => setActiveRun(null)} />
      )}
    </main>
  )
}
