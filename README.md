# Fintech Linear Quote Interpolation — Time Synchronization Algorithm

> A canonical, well-specified, **cross-language (Python + TypeScript)** reference
> implementation of bitemporal linear quote interpolation. Linear interpolation
> **reaches forward in time** — to value 10:00:01 it needs the quote at 10:00:02 — so
> an interpolated value is never an observed quote and must never reach anything
> pretending to run live. This implementation makes that impossible to forget: every
> result is stamped `observable` / `interpolated`, carries the `first_knowable_at` when
> both endpoints had landed, and refuses to extrapolate. A `leakage` surface measures
> how wrong the straight line actually is on **your** data by leave-one-out validation,
> and the live engine **waits** instead of guessing.

<p>
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-blue">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.7%2B-3178c6">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Tests" src="https://img.shields.io/badge/tests-124%20py%20%2F%20121%20ts-brightgreen">
</p>

**📖 Full article (canonical):** **[Linear Quote Interpolation — The Fintech Builder](https://thefintechbuilder.com/market-data-engineering/time-synchronization/linear-quote-interpolation/)**

This repository is the runnable, production-oriented companion to that article.
The article teaches the concept; this repo is the code you install and build on.

🧭 **Browse all algorithms:** [Awesome FinTech Algorithms](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome) — the full index of the library.
🗂️ **This algorithm's domain:** [Market Data Engineering](https://thefintechbuilder.com/domains/market-data-engineering/) › **Time Synchronization**
📥 **Just want to call it?** It also ships in the [`fintech-algorithms`](https://www.npmjs.com/package/fintech-algorithms) npm package — see [Two ways to use this](#two-ways-to-use-this).

| | |
|---|---|
| **Catalog topic** | `D01-F03-A02` |
| **Domain** | D01 — Market Data Engineering |
| **Family** | D01-F03 — Time Synchronization |
| **Difficulty** | 3 / 5 |
| **Languages** | Python, TypeScript |

---

## Table of contents

- [The one thing to understand](#the-one-thing-to-understand)
- [Seven statuses, and why none of them is a null](#seven-statuses-and-why-none-of-them-is-a-null)
- [Extrapolation is refused](#extrapolation-is-refused)
- [Two ways to use this](#two-ways-to-use-this)
- [Install](#install)
- [Quickstart](#quickstart)
- [Worked example (exact)](#worked-example-exact)
- [Leakage: error, cost, and the gap budget](#leakage-error-cost-and-the-gap-budget)
- [The engine that waits](#the-engine-that-waits)
- [Row shapes](#row-shapes)
- [API reference](#api-reference)
- [Edge cases & limitations](#edge-cases--limitations)
- [Testing](#testing)
- [Related algorithms](#related-algorithms)
- [License](#license)

---

## The one thing to understand

**Previous-tick carry-forward looks backward. Linear interpolation looks forward.**

To interpolate a value at 10:00:01 you need the quote *after* it, at 10:00:02. At
10:00:01 that quote had not happened and could not have been known. So an interpolated
value is a **research construct**, not an observation:

> Legal in a covariance estimate. Fraudulent in a signal.

Nothing in this library will stop you putting an interpolated price into a trading
rule — but it will make you do it with your eyes open. Every result carries:

| Field | Meaning |
|---|---|
| `observable` | `true` **only** for an exactly-matching record that had already arrived |
| `interpolated` | `true` for anything the straight line produced |
| `first_knowable_at` | the moment both endpoints had landed — the earliest a live system could have computed this at all |

If `observable` is `false`, the number in front of you did not exist at the time it is
labelled with.

---

## Seven statuses, and why none of them is a null

| `status` | Meaning |
|---|---|
| `exact` | a record sits exactly on the target **and** had arrived — the only observation |
| `linear` | both endpoints arrived; the value is interpolated |
| `exact_not_available` | the exact record exists but had not arrived yet |
| `left_not_available` | the left endpoint had not arrived by `evaluation_time` |
| `right_not_available` | the right endpoint had not arrived by `evaluation_time` |
| `gap_too_wide` | the bracketing interval exceeds `max_gap_ms` |
| `unavailable` | no bracketing pair at all, or no such partition |

The `*_not_available` statuses come with **`wait_ms`** — how much longer you would have
had to wait for that value to be real. That is the actionable number, and a bare `null`
would have thrown it away. "The data is missing" and "you asked 1,120 milliseconds too
early" call for entirely different responses.

A batch is never aborted by an unreachable target. One bad point returns a status; the
other targets still get answered.

---

## Extrapolation is refused

A target outside the observed range returns `unavailable` with reason
`extrapolation_disabled`. Not an error, not a straight line continued past the last
quote — a refusal.

Extending a line beyond the data is a claim about a region where nothing was measured.
Inside a bracket, interpolation at least sits between two real observations and its
error is bounded by them. Outside, there is no anchor and no bound, and the error grows
without limit in a way nothing in the output would reveal.

---

## Two ways to use this

**📥 The fast path — one call, TypeScript only:**

```bash
npm install fintech-algorithms
```

```ts
import { linearQuoteInterpolation } from "fintech-algorithms/market-data-engineering/time-synchronization/linear-quote-interpolation";
```

That package is the breadth option: 271 algorithms, one install, the tutorial-level
kernel for each.

**🔬 This repo — the depth option.** Python *and* TypeScript, the `leakage` surface
(leave-one-out error, lookahead cost, gap profiling), the pending engine, strict
calendar validation, and 245 tests pinning both languages to one shared fixture. Use it
when the interpolated values are going into research someone will act on.

---

## Install

**Python** (3.10+, no dependencies):

```bash
git clone https://github.com/IslamBaraka90/Fintech-Linear-Quote-Interpolation-Time-Synchronization-algorithm.git
cd Fintech-Linear-Quote-Interpolation-Time-Synchronization-algorithm/python
pip install -e ".[dev]"
```

**TypeScript** (Node 20+, no runtime dependencies):

```bash
cd Fintech-Linear-Quote-Interpolation-Time-Synchronization-algorithm/typescript
npm install
npm run build
```

---

## Quickstart

**Python**

```python
from fintech_linear_quote import linear_quote_interpolation

P = {"instrument": "A", "venue": "X", "session_id": "S"}

quotes = [
    {**P, "event_time": "2026-01-01T00:00:00.000Z",
     "available_time": "2026-01-01T00:00:00.100Z", "bid": 99.0, "ask": 101.0},
    {**P, "event_time": "2026-01-01T00:00:02.000Z",
     "available_time": "2026-01-01T00:00:02.120Z", "bid": 101.0, "ask": 103.0},
]

targets = [{**P, "target_time": "2026-01-01T00:00:01.000Z",
            "evaluation_time": "2026-01-01T00:00:02.120Z"}]

row = linear_quote_interpolation(quotes, targets, max_gap_ms=2000)[0]
print(row["status"], row["bid"], row["observable"])   # linear 100.0 False
```

**TypeScript**

```ts
import { linearQuoteInterpolation } from "fintech-linear-quote";

const row = linearQuoteInterpolation(quotes, targets, 2000)[0]!;
console.log(row.status, row.bid, row.observable);     // linear 100 false
```

---

## Worked example (exact)

Two quotes two seconds apart, `max_gap_ms = 2000`. These statuses are asserted verbatim
by both test suites from one shared JSON fixture.

**Quotes**

| event_time | available_time | bid | ask |
|---|---|---|---|
| 00:00:00.000 | 00:00:00.100 | 99 | 101 |
| 00:00:02.000 | 00:00:02.120 | 101 | 103 |

**Targets and results**

| target | evaluated at | status | bid | note |
|---|---|---|---|---|
| 00:00:01 | 00:00:01.000 | `right_not_available` | — | `wait_ms = 1120` |
| 00:00:01 | 00:00:02.120 | `linear` | **100.0** | `weight = 0.5`, `gap_ms = 2000` |
| 00:00:00 | 00:00:00.000 | `exact_not_available` | — | `wait_ms = 100` |
| 00:00:00 | 00:00:00.100 | `exact` | 99.0 | the only `observable: true` row |
| 23:59:59 (prior day) | 00:00:03.000 | `unavailable` | — | `extrapolation_disabled` |

Rows 1 and 2 are the **same target point** at two knowledge times. One has no honest
answer; the other does. That difference is the entire algorithm.

---

## Leakage: error, cost, and the gap budget

This is the surface that does not fit in a tutorial, and the reason to install the repo
rather than copy the snippet.

### `interpolation_error` — leave-one-out validation on your own data

For every interior quote: hide it, rebuild it from its two neighbours, compare. You get
an empirical error distribution for exactly the instrument, venue and session you are
about to interpolate — the honest answer to *"is linear good enough here"*, for one
pass over data you already have.

```
at max_gap_ms=2000: checked 0, skipped 1 (bracket too wide)
at max_gap_ms=5000: checked 1 interior quote(s)
  max absolute bid error: 1.3333
  worst error in spreads: 0.6667
```

`max_error_in_spreads` is the number to read. An absolute price error means nothing on
its own — 0.01 is enormous on a 0.005-wide book and invisible on a 5.00-wide one.
**Half a spread is noise. Two spreads means the line is inventing a price level that
never traded.**

### `lookahead_cost` — what point-in-time honesty cost you

Evaluates every target twice: once respecting `evaluation_time`, and once the way a
revised historical file lets you cheat.

```
1/1 targets differ
  honest=right_not_available (bid=None)  revised=linear (bid=100.0)  wait=1120ms
```

A target that is only valuable under the revised view is one a live system could never
have produced.

### `gap_profile` — where the budget should sit

Observed inter-quote gaps per partition, with median, p95 and max. A `max_gap_ms` below
the median makes most targets `gap_too_wide`; one above the maximum is not constraining
anything. The useful settings live between the two.

### `status_summary` — measurement or model?

```
1 observed, 1 interpolated, 0 unresolved  (observable share 50%)
```

A research set that is 95% interpolated is a model output, whatever the column headers
say.

---

## The engine that waits

There is no streaming linear interpolation, and pretending otherwise is how lookahead
gets into a pipeline. `PendingInterpolator` does the only honest thing: it **holds the
target open** until both bracketing endpoints have arrived.

```python
live = PendingInterpolator(max_gap_ms=2000)
live.observe(first_quote)
live.submit({**P, "target_time": "2026-01-01T00:00:01.000Z"})

live.resolve()        # [] — the right endpoint does not exist yet
live.pending          # [{... "status": "unavailable"}]

live.observe(second_quote)
live.resolve()        # [{"status": "linear", "bid": 100.0, ...}]
```

`pending` is not a queue of failures; it is an accurate statement of what is not yet
knowable. The engine's clock is the latest `available_time` ingested — feeding it a
quote is the only thing that moves time forward, which is exactly how a real consumer
experiences it.

`gap_too_wide` settles **immediately** rather than waiting, because no amount of
waiting will narrow the gap.

---

## Row shapes

**Quote** — `instrument`, `venue`, `session_id` (all non-empty strings), `event_time`,
`available_time` (RFC 3339 UTC, `Z` only, millisecond precision at most,
`available_time >= event_time`), `bid`, `ask` (finite numbers, `bid <= ask`).

**Target** — the same three partition keys, plus `target_time` and `evaluation_time`.

**Result** — `bid`, `ask`, `status`, `reason`, `interpolated`, `observable`,
`left_event_time`, `right_event_time`, `left_available_time`, `right_available_time`,
`first_knowable_at`, `weight`, `gap_ms`, `wait_ms`.

Two details that exist because they were wrong somewhere else first:

- **`first_knowable_at` is computed on the parsed clock, not by string comparison.**
  `"…00.500Z"` sorts *before* `"…00Z"` lexicographically while being half a second
  later in fact, so a string `max` picks the wrong endpoint on mixed-precision feeds.
- **Prices must be numbers, not numeric strings.** `float("100.5")` would succeed in
  Python where TypeScript refuses it; both ports here reject it, so the same input
  gives the same answer in either language.

Timestamps are validated by explicit civil arithmetic rather than `Date.parse`, which
silently rolls `2026-02-30` over to March 2.

---

## API reference

| Python | TypeScript | Purpose |
|---|---|---|
| `linear_quote_interpolation(quotes, targets, max_gap_ms)` | `linearQuoteInterpolation(...)` | Batch interpolation under a cutoff |
| `interpolation_error(quotes, max_gap_ms)` | `interpolationError(...)` | Leave-one-out error on your own data |
| `lookahead_cost(quotes, targets, max_gap_ms)` | `lookaheadCost(...)` | Point-in-time vs revised-file view |
| `gap_profile(quotes)` | `gapProfile(...)` | Inter-quote gap distribution |
| `status_summary(results)` | `statusSummary(...)` | Observed vs constructed roll-up |
| `PendingInterpolator(max_gap_ms, resolve_unavailable=False)` | `new PendingInterpolator(...)` | The engine that waits |
| `.observe(quote)` / `.submit(target)` | `.observe(...)` / `.submit(...)` | Ingest and register |
| `.resolve()` / `.pending` | `.resolve()` / `.pending` | Collect what is knowable |
| `parse_timestamp_ms(value)` | `parseTimestampMs(...)` | Strict RFC 3339 → milliseconds |

---

## Edge cases & limitations

- **An interpolated value is not a quote.** It is a weighted average of two quotes that
  bracket it, and the market may have done anything in between — including trading
  outside the bracket entirely. `interpolation_error` is how you find out how much that
  matters on your data.
- **Never feed an interpolated price to a live signal.** `observable` is `false` for a
  reason.
- **Extrapolation is refused, not approximated.** If you need a value outside the
  observed range, previous-tick carry-forward is the honest tool.
- **`bid <= ask` is enforced on endpoints.** A crossed endpoint would produce a quote
  that is crossed for part of the interval and not for the rest, which is not a quote.
  A *locked* endpoint (`bid == ask`) is allowed.
- **Partitions never bleed.** `instrument` + `venue` + `session_id` is the identity;
  interpolating across a session boundary would span the overnight gap as if it were a
  tick.
- **The gap budget is checked before availability.** A target failing both reports the
  structural reason, which is the one that will not fix itself.
- **Millisecond precision.** Timestamps with more than three fractional digits are
  rejected rather than silently truncated.

---

## Testing

```bash
cd python && pytest -q          # 124 tests
cd typescript && npm test       # 121 tests
```

Both suites read the **same** `fixtures.json`, and the five statuses in the
[worked example](#worked-example-exact) are asserted verbatim in each language.

The suites also pin the behaviours most likely to drift: `first_knowable_at` on a
mixed-precision feed, string prices rejected in both languages, `2026-02-30` refused
(with a test proving `Date.parse` would have rolled it to March 2), quote order not
affecting the answer, and the pending engine's result matching the batch function
exactly.

---

## Related algorithms

**Same family — D01-F03 Time Synchronization**

- **[Previous-Tick Interpolation](https://github.com/IslamBaraka90/Fintech-Previous-Tick-Interpolation-Time-Synchronization-algorithm)** — the backward-looking counterpart, and the one that *is* safe live.
- **[Refresh-Time Sampling](https://github.com/IslamBaraka90/Fintech-Refresh-Time-Sampling-Time-Synchronization-algorithm)** — sampling on a barrier defined by the data instead of the clock.
- Exchange Calendar Alignment · Asynchronous Return Alignment *(articles live; repos pending)*

**Upstream — D01-F02 Cleaning and Validation**

- **[Stale Quote Detector](https://github.com/IslamBaraka90/Fintech-Stale-Quote-Detector-Data-Quality-algorithm)** · **[Crossed/Locked Market Detector](https://github.com/IslamBaraka90/Fintech-Crossed-Locked-Market-Detector-Data-Quality-algorithm)** — the validation this algorithm assumes has already happened.

🧭 **[Browse all algorithms →](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome)**

---

## License

MIT — see [LICENSE](LICENSE).

The synthetic fixture data is CC0-1.0. No market data is redistributed.
