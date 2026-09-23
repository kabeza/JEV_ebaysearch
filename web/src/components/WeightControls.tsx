import {
  DEFAULT_SETTINGS,
  GATE_SIGNALS,
  WEIGHTED_SIGNALS,
  type GateSignal,
  type ReportSettings,
  type WeightedSignal,
} from '../lib/score'
import { labelFor } from '../lib/answers'

/** Human names for the two signals that do not come from a question. */
const SIGNAL_LABELS: Record<string, string> = {
  seller_feedback: 'Seller feedback',
  shipping: 'Shipping cost',
}

function name(signal: string): string {
  return SIGNAL_LABELS[signal] ?? labelFor(signal)
}

interface Props {
  settings: ReportSettings
  onChange: (next: ReportSettings) => void
  onReset: () => void
  counts: { matching: number; discarded: number; pending: number }
}

/**
 * Every control in one panel, and every one of them local: moving a slider
 * re-sorts rows already in the page and costs no request (spec §5.6).
 *
 * Each input carries a stable `aria-label`, which is what the browser-level
 * check in `scripts/repro-live-ui.ts` drives to prove the zero-request claim.
 */
export function WeightControls({ settings, onChange, onReset, counts }: Props) {
  // Typed by signal, not by string: the compiler then checks that a control
  // exists for every weighted signal and none that is not one.
  const setWeight = (signal: WeightedSignal, value: number) =>
    onChange({ ...settings, weights: { ...settings.weights, [signal]: value } })
  const setGate = (signal: GateSignal, value: number) =>
    onChange({ ...settings, gates: { ...settings.gates, [signal]: value } })

  return (
    <div className="mb-4 grid gap-4 rounded border border-lilac-ash/20 p-4 md:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm text-lilac-ash">Weights</h3>
        <ul className="space-y-1">
          {WEIGHTED_SIGNALS.map((signal) => (
            <li key={signal} className="flex items-center gap-3 text-sm">
              <span className="w-40 shrink-0 text-lilac-ash">{name(signal)}</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                aria-label={`weight ${signal}`}
                value={settings.weights[signal]}
                onChange={(e) => setWeight(signal, Number(e.target.value))}
                className="w-32"
              />
              <span className="font-mono text-almond-silk">
                {settings.weights[signal].toFixed(1)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="mb-2 text-sm text-lilac-ash">
            Gates — a listing below either is discarded
          </h3>
          <ul className="space-y-1">
            {GATE_SIGNALS.map((signal) => (
              <li key={signal} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 text-lilac-ash">{name(signal)}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  aria-label={`gate ${signal}`}
                  value={settings.gates[signal]}
                  onChange={(e) => setGate(signal, Number(e.target.value))}
                  className="w-32"
                />
                <span className="font-mono text-almond-silk">
                  {settings.gates[signal].toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm text-lilac-ash">
          <label className="flex items-center gap-2">
            match
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              aria-label="match threshold"
              value={settings.matchThreshold}
              onChange={(e) => onChange({ ...settings, matchThreshold: Number(e.target.value) })}
              className="w-28"
            />
            <span className="font-mono text-almond-silk">
              {settings.matchThreshold.toFixed(2)}
            </span>
          </label>
          <label className="flex items-center gap-2">
            highlight
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              aria-label="highlight threshold"
              value={settings.highlightThreshold}
              onChange={(e) => onChange({ ...settings, highlightThreshold: Number(e.target.value) })}
              className="w-28"
            />
            <span className="font-mono text-almond-silk">
              {settings.highlightThreshold.toFixed(2)}
            </span>
          </label>
          <label className="flex items-center gap-2">
            max rows
            <input
              type="number"
              min={1}
              max={500}
              aria-label="max rows"
              value={settings.maxRows}
              onChange={(e) =>
                onChange({ ...settings, maxRows: Math.max(1, Number(e.target.value)) })
              }
              className="w-16 rounded border border-lilac-ash/40 bg-transparent px-1 text-almond-silk"
            />
          </label>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2 text-lilac-ash">
            <input
              type="checkbox"
              aria-label="show discarded"
              checked={settings.showDiscarded}
              onChange={(e) => onChange({ ...settings, showDiscarded: e.target.checked })}
            />
            show {counts.discarded} discarded
          </label>
          <button
            onClick={onReset}
            className="rounded border border-lilac-ash/50 px-2 py-1 text-xs text-lilac-ash"
          >
            reset to defaults
          </button>
          <span className="text-xs text-lilac-ash/60">
            defaults: {DEFAULT_SETTINGS.matchThreshold} match, {DEFAULT_SETTINGS.highlightThreshold}{' '}
            highlight
          </span>
        </div>
      </div>
    </div>
  )
}
