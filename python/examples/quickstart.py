"""Interpolate a quote, then find out whether you should have.

Run:  python examples/quickstart.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fintech_linear_quote import (  # noqa: E402
    PendingInterpolator,
    gap_profile,
    interpolation_error,
    linear_quote_interpolation,
    lookahead_cost,
    status_summary,
)

P = {"instrument": "A", "venue": "X", "session_id": "S"}

QUOTES = [
    {**P, "event_time": "2026-01-01T00:00:00.000Z",
     "available_time": "2026-01-01T00:00:00.100Z", "bid": 99.0, "ask": 101.0},
    {**P, "event_time": "2026-01-01T00:00:02.000Z",
     "available_time": "2026-01-01T00:00:02.120Z", "bid": 101.0, "ask": 103.0},
    {**P, "event_time": "2026-01-01T00:00:03.000Z",
     "available_time": "2026-01-01T00:00:03.050Z", "bid": 100.0, "ask": 102.0},
]

MAX_GAP_MS = 2000


def rule(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


# --- 1. the same target, asked too early and then late enough -------------- #
rule("1. The knowledge cutoff decides whether there is an answer at all")

for evaluation in ("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.120Z"):
    row = linear_quote_interpolation(
        QUOTES,
        [{**P, "target_time": "2026-01-01T00:00:01.000Z", "evaluation_time": evaluation}],
        MAX_GAP_MS,
    )[0]
    detail = (f"bid={row['bid']}" if row["bid"] is not None
              else f"wait {row['wait_ms']}ms longer")
    print(f"  evaluated at {evaluation[-13:-1]}  ->  {row['status']:<22} {detail}")
print("  The right-hand endpoint had not arrived. There was no honest answer yet.")

# --- 2. interpolated is never observed ------------------------------------- #
rule("2. Interpolated is never observed")

targets = [
    {**P, "target_time": "2026-01-01T00:00:00.000Z", "evaluation_time": "2026-01-01T00:00:09Z"},
    {**P, "target_time": "2026-01-01T00:00:01.000Z", "evaluation_time": "2026-01-01T00:00:09Z"},
]
for row in linear_quote_interpolation(QUOTES, targets, MAX_GAP_MS):
    print(f"  {row['target_time'][-13:-1]}  {row['status']:<8} "
          f"bid={row['bid']:<7} observable={row['observable']!s:<6} "
          f"interpolated={row['interpolated']}")
print("  Only the exact, already-arrived record is an observation. The other is arithmetic.")

# --- 3. how wrong is the straight line, on this data? ---------------------- #
rule("3. Leave-one-out: how wrong is the line here?")

# The only interior quote is bracketed by 00:00 and 00:03 — a 3000ms span. At the
# 2000ms budget that bracket is skipped, which is the sweep telling you the budget
# is doing real work rather than rubber-stamping.
tight = interpolation_error(QUOTES, MAX_GAP_MS)["overall"]
print(f"  at max_gap_ms={MAX_GAP_MS}: checked {tight['checked']}, "
      f"skipped {tight['skipped']} (bracket too wide)")

stats = interpolation_error(QUOTES, 5000)["overall"]
print(f"  at max_gap_ms=5000: checked {stats['checked']} interior quote(s)")
print(f"    max absolute bid error: {stats['max_abs_bid_error']:.4f}")
print(f"    worst error in spreads: {stats['max_error_in_spreads']:.4f}")
print("  Hidden each interior quote, rebuilt it from its neighbours, compared.")

# --- 4. what did honesty cost? --------------------------------------------- #
rule("4. Lookahead a revised-file backtest would have absorbed")

early = [{**P, "target_time": "2026-01-01T00:00:01.000Z",
          "evaluation_time": "2026-01-01T00:00:01.000Z"}]
cost = lookahead_cost(QUOTES, early, MAX_GAP_MS)
print(f"  {cost['summary']['differing']}/{cost['summary']['total_targets']} targets differ")
for row in cost["rows"]:
    print(f"    honest={row['point_in_time_status']} (bid={row['point_in_time_bid']})  "
          f"revised={row['revised_status']} (bid={row['revised_bid']})  "
          f"wait={row['wait_ms']}ms")

# --- 5. where should the gap budget sit? ----------------------------------- #
rule("5. Gap profile")

profile = gap_profile(QUOTES)["overall"]
print(f"  {profile['quotes']} quotes, {profile['gaps']} gaps: "
      f"min={profile['min_ms']:.0f}ms median={profile['median_ms']:.0f}ms "
      f"max={profile['max_ms']:.0f}ms")

# --- 6. the engine that waits ---------------------------------------------- #
rule("6. Interpolation has to wait, so the engine waits")

live = PendingInterpolator(MAX_GAP_MS)
live.observe(QUOTES[0])
live.submit({**P, "target_time": "2026-01-01T00:00:01.000Z"})
print(f"  after 1 quote:  resolved={len(live.resolve())}  pending={live.pending_count} "
      f"({live.pending[0]['status']})")

live.observe(QUOTES[1])
settled = live.resolve()
print(f"  after 2 quotes: resolved={len(settled)}  pending={live.pending_count}")
print(f"  -> {settled[0]['status']} bid={settled[0]['bid']} "
      f"first_knowable_at={settled[0]['first_knowable_at']}")

# --- 7. what is this batch actually made of? ------------------------------- #
rule("7. Measurement or model?")

summary = status_summary(linear_quote_interpolation(QUOTES, targets, MAX_GAP_MS))
print(f"  {summary['observable']} observed, {summary['interpolated']} interpolated, "
      f"{summary['unresolved']} unresolved  "
      f"(observable share {summary['observable_share']:.0%})")
