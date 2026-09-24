# Stage 6 — the report and its controls

Design for the stage that turns stored judgments into the thing the app exists to produce: a ranked
list of matching listings, with the weighting visible and editable.

Parent documents: `docs/superpowers/specs/2026-09-18-jevbrowser-design.md` (§5.6, §5.6.1, §5.6.2,
§8.5) and `docs/superpowers/plans/2026-09-18-jevbrowser-build-plan.md` (Stage 6). This document only
resolves what those left open. Where they disagree with it, it wins for Stage 6 and they should be
corrected.

Agreed with the owner on 2026-09-23, before any code was written.

## 1. What has to be true when this is done

- A ranked list of matching listings, each with **its URL**, price, shipping, condition and its
  answers.
- Weight sliders, gate thresholds, a match threshold, a highlight threshold, sort by any column,
  and a maximum number of rows.
- Every row expands to the raw answers: value, probabilities, confidence, legend.
- CSV and JSON export, containing the URL of every matching listing.
- **Changing any control triggers no new scraping and no JEV call.** This is the stage's whole
  point: the answers are already bought, so tuning them is free (spec §5.6, §8.5).

## 2. Where it lives

The survivor table inside `web/src/components/RunView.tsx` **becomes** the report. There is one
table, not a live table and a separate report: while a run is in flight the report is simply
re-sorting as answers arrive, and when the run ends it is the final ranking. A second table would
be two implementations of one thing, and they would drift.

RunView keeps its job: the SSE stream, the event feed, the run header, cancel and close. Everything
about ranking moves out of it into the report.

## 3. The composition, in code not in the model

Spec §8.5: **gates** are absolute, **qualities** are weighted, and the code owns the arithmetic.
Judgments are stored, so this is pure arithmetic over data already in the browser.

### 3.1 Normalising an answer

The trap from Stage 5 (CLAUDE.md rule 12): a noul lives on 0…1, a score lives on 0…n-1.

```
normaliseAnswer(answer) =
  answer.noul                            if noul is a number
  answer.score / (levels - 1)            if score is a number, levels = Object.keys(legend).length
  null                                   otherwise
```

`levels` comes from the answer's own `legend`, never from a hardcoded 5 — the legend length is the
scale, and the API is free to return four levels for one question and five for another.

A `null` is not a zero and not a 0.5. It means JEV said nothing usable, and the next section says
what happens to it.

### 3.2 Two signals that come from code, not from JEV

**Shipping**, in absolute dollars, inverted and bounded (spec §5.6.2). The scale is the spread of
shipping costs in the current run, so a slider stays meaningful whether the spread is $0–$20 or
$0–$200. Measured on run 8 (2026-09-23), a real spread is `0 … $142.30` across 18 distinct values,
so this is not a hypothetical range.

```
free (shipping === 0)   -> 1.0
paid                    -> 0.9 * (1 - (ship - min) / (max - min))
no spread (max === min) -> 0.5  for every paid row
```

`min` and `max` are taken over **every** row whose shipping is known, free rows included, so a run
whose cheapest option is free has `min = 0` and its cheapest *paid* row lands just under 0.9. The
0.9 ceiling is what keeps free shipping strictly on top; it is not a claim that 0.9 is the best a
paid rate can do.

Free is **1.0**, strictly above the best paid row's **0.9**: free shipping is a bonus, not merely a
zero cost, and it must outrank the cheapest paid row rather than tie with it. When every paid row
costs the same there is no information in the signal, so every row gets the middle and the blend is
not quietly told something false.

**Seller feedback**, ranked within the run, not used raw. Raw percentages are compressed into
97–100% — 539 stored samples span `97.1% … 100%` — so raw would give every seller almost the same
value and a slider over it would move nothing. The first draft of this section rescaled between the
run's minimum and maximum instead, and **real data broke that**: 13 stored listings carry
`0% positive (0)`, which set the floor at 0 and squeezed all 17 real sellers in run 8 into
0.961–1.000 — a spread of 0.039, so the weight moved almost nothing, the exact failure the rescale
was introduced to prevent.

```
rank of pct among the run's parseable percentages, ties sharing the average index
  best present -> 1.0, worst -> 0.0
fewer than two records, or a pct not in the run's own set -> 0.5
unparseable / absent                                     -> null, a missing answer
```

A rank cannot be dragged by an outlier, and "better than the other sellers in this run" is what the
report ranks on. What it gives up is proportionality: a seller two points above another scores the
same as one half a point above it. The absolute percentage is still printed in the row, so the
reader who wants the ratio has it.

### 3.3 The signals

| Signal | Source | Kind | Default |
|---|---|---|---|
| `is_target_product` | JEV | gate, threshold | 0.5 |
| `condition_ok` | JEV | gate, threshold | 0.5 |
| `spec_match` | JEV | weighted | 1.0 |
| `price_value` | JEV | weighted | 1.0 |
| `listing_trust` | JEV | weighted | 1.0 |
| `criteria_freeform` | JEV | weighted | 1.0 |
| seller feedback | code | weighted | 1.0 |
| shipping | code | weighted | 1.0 |

Equal default weights on purpose: the spec says the user controls them, and an opinionated default
would be the app guessing at a ranking the user has not stated. Gates default to 0.5 and the match
threshold to 0.6, as spec §8.5 already fixed.

**A missing answer is excluded, and the remaining weights are renormalised.** If JEV never answered
`price_value` for a listing, that listing is ranked on the five signals it does have, at their
relative weights, and its row says which signal is missing. Substituting 0.5 would be inventing a
mediocre answer out of silence — the same mistake `matchCondition` already refuses to make at the
other end of the pipeline.

### 3.4 The blend and the gates

```
passes_gates(listing)  = is_target_product >= gate.is_target_product
                       AND condition_ok   >= gate.condition_ok
blended(listing)       = sum(weight_i * value_i) / sum(weight_i)   over signals with a value
highlighted(listing)   = passes_gates AND blended >= highlight threshold
```

Gates come first and are absolute: a great price never rescues a charger (spec §8.5). A row that
failed a gate can never be highlighted, including when it is shown via the toggle in §5.

If every weight is dragged to zero the denominator is zero: the report then shows no blend and no
order at all, and says so in one line, rather than rendering `NaN` or silently ordering by something
else.

## 4. Files

| File | Responsibility |
|---|---|
| `web/src/lib/score.ts` | new — `normaliseAnswer`, `shippingScore`, `sellerTrustScore`, `compose`, `rankReport`. Pure: no fetch, no clock, no DOM. |
| `web/src/lib/sellerTrust.ts` | new — parse the feedback string, three-tier classification. |
| `web/src/lib/export.ts` | new — `toCsv`, `toJson`, `download`. |
| `web/src/components/ReportTable.tsx` | new — the ranked table: sorting, expansion, badges, highlight, the discarded toggle. |
| `web/src/components/WeightControls.tsx` | new — every control, in one place. |
| `web/src/components/AnswerDetail.tsx` | new — extracted from RunView so the feed and a report row share one panel. |
| `web/src/components/SellerBadge.tsx` | new — the three tiers. |
| `web/src/components/RunView.tsx` | changed — keeps SSE, feed, header; its table becomes `<ReportTable>`. |

`score.ts` mirrors the semantics the server already applies in `src/pipeline/prefilter.ts` (a gate
that rejects is a gate that rejects), but it is a browser-side library and the server must not
import it. The two are kept consistent by the thresholds being named once in this document, not by
shared code.

## 5. The controls

One panel above the table: six weight sliders (0…2), two gate thresholds (0…1), the match threshold,
the highlight threshold, a maximum-rows selector, and a reset to the defaults in §3.3. Defaults not
already fixed there: highlight 0.75, maximum rows 50. The table opens sorted by blend descending;
clicking a column header sorts by that column, and clicking it again reverses the direction.

Controls are plain React state — no URL, no server, no persistence. A reload returns to the
defaults.

Two behaviours the table owes the reader:

- **Rows that fail a gate or the match threshold are hidden by default**, with a visible
  `N discarded` counter and a toggle that reveals them, greyed and unhighlightable. Rows must never
  vanish without a trace: a gate the user set too tight is exactly the thing they need to inspect,
  and this project has already learned that a wrong reject that leaves no trace is unrecoverable.
- **Rows with no judgments yet** — a run still in flight, or a survivor whose batch has not returned
  — show their card data and say `not judged yet`, with no blend and no rank. Sorting by blend puts
  them last rather than at 0, which would be a rank the data does not support. **They have no blend
  at all, not a blend over the signals that happen to exist yet:** shipping and a seller record
  alone blended to 0.99 in run 8's first batch and put ten unjudged listings above every judged one,
  which was the first critical finding of the review.
- **A discarded row says why it was discarded**, in the row: `failed the is_target_product gate:
  0.02 below 0.50`, `below the match threshold: 0.588 below 0.60`, or `no weighted answers to
  blend`. Without it a gate reject and a threshold miss are indistinguishable, and the toggle exists
  so the reader can tell which reject is absolute and which one their own thresholds caused.

Empty states are stated, never implied: no survivors, no judgments, and no discarded rows each get
an explicit line of text (CLAUDE.md rule 7 — silence is a bug, at the UI layer too).

## 6. Seller trust marking

The stored string is raw text on every card, e.g. `"99.8% positive (19K)"` (spec §5.6.1). Parsing is
code, and so is the tier. Real samples from 539 stored listings:

```
99.1% positive (17K)   100% positive (465)    98.7% positive (2.8K)
97.1% positive (969.9K)  100% positive (45)     99.7% positive (346.5K)
```

The parser accepts `<pct>% positive (<count>)`, where the count is `1,234`, `1234`, `17K`, `2.8K`,
`969.9K` or `1.2M`; anything else returns `null` with no guess. The count is **always** displayed,
in every tier — inside the badge where there is one, beside the percentage where there is not.

| Tier | Condition | Display |
|---|---|---|
| Trusted | exactly 100% and count ≥ 100 | solid badge, count in it |
| Flawless but new | exactly 100% and count < 100 | faded badge, count in it |
| Not marked | below 100%, or unparseable | no badge; the row reads `99.1% · 17,000`, or `—` when nothing parses |

**Ruling (2026-09-24).** The prose above and the table disagreed about the Not marked tier: the prose
said the count is always shown, the table mentioned only the percentage. The prose wins, and the tier
with no badge now carries the count too. The reason is the one the badge exists for — 99.1% of 17,000
is not 99.1% of 3 — and dropping it in the one tier where the percentage is worst is exactly
backwards. `trustRowText` in `sellerTrust.ts` owns it.

100% of 3 reviews is not 100% of 17,000, which is why the tier is split and why the count travels
with the badge — the reader judges, the badge does not (spec §5.6.1). `100% positive (45)` and
`100% positive (465)` both exist in real data, so both tiers are exercised by real strings.

## 7. Export

- **CSV** — one row per row the table is showing: title, URL, price, shipping, condition, seller,
  feedback, the trust tier, each signal's normalised value, the blend, whether it is highlighted, and
  which of the three states it is in (`matching`, `discarded`, `not judged yet`). Resolved answers
  only, so the file opens as a table.
- **JSON** — the same rows plus the **raw** answers (value, probabilities, confidence, legend) for
  every question. This is the file that can be re-analysed without calling JEV again, which is the
  property the whole stage rests on.
- Both are built in the browser from the rows already on screen and downloaded with a `Blob`. No
  endpoint, no server round trip.
- Export writes whichever rows the table is currently showing — the discarded ones are not in it
  unless the toggle is on, in which case **the export follows what is on screen** and the row's state
  is a column. The unjudged rows are on screen too, so they are in the file, with
  `not judged yet` beside a null blend; they are not called discarded, which would say a threshold
  threw them out when no question has been asked yet. What you see is what you get.

## 8. Testing

**Vitest, against the pure libraries.** `tests/score.test.ts`, `tests/seller-trust.test.ts`,
`tests/export.test.ts` — the existing pattern (`tests/web-spec.test.ts` already tests a `web/src/lib`
module from the server-side suite). The cases that matter:

- a noul and a score normalise to the same 0…1 scale; a four-level legend normalises against four;
- a missing answer is excluded and the other weights renormalise — asserted by a listing missing a
  signal outranking one that has it low;
- free shipping beats the cheapest paid row; a spread of one value (or none) yields the middle
  rather than dividing by zero;
- the feedback parser on every real form above, and `null` on `"PowerSeller"`;
- a row failing a gate is never highlighted, at any weight or threshold;
- CSV has one line per matching row and the URL of each; JSON round-trips the raw answers unchanged.

**The browser-level claim needs a browser.** "Moving a control makes zero requests" cannot be
established by vitest here: the project has neither jsdom nor a DOM testing library, and adding one
for this alone is not worth the dependency. Instead `scripts/repro-live-ui.ts` — which already drives
the real UI over captured fixtures with a fake JEV client and has caught two defects no unit test
could — gains a request counter and prints `requests during a weight change: 0` after it moves a
slider and re-sorts. That is the acceptance criterion, measured where it is actually claimed.

## 9. Out of scope

- Re-judging a stored run with edited questions, and question versioning — Stage 7.
- The sponsored marker — still a known defect, still deliberately unshown (CLAUDE.md rule 5).
- Any server-side ranking, export endpoint, or saved weight presets.
