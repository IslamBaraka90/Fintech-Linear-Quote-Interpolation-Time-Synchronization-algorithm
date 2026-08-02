/**
 * Interpolate a quote, then find out whether you should have.
 *
 * Run:  npm run example
 */

import {
  PendingInterpolator,
  gapProfile,
  interpolationError,
  linearQuoteInterpolation,
  lookaheadCost,
  statusSummary,
  type Quote,
} from "../src/index.ts";

const P = { instrument: "A", venue: "X", session_id: "S" };

const QUOTES: Quote[] = [
  { ...P, event_time: "2026-01-01T00:00:00.000Z",
    available_time: "2026-01-01T00:00:00.100Z", bid: 99.0, ask: 101.0 },
  { ...P, event_time: "2026-01-01T00:00:02.000Z",
    available_time: "2026-01-01T00:00:02.120Z", bid: 101.0, ask: 103.0 },
  { ...P, event_time: "2026-01-01T00:00:03.000Z",
    available_time: "2026-01-01T00:00:03.050Z", bid: 100.0, ask: 102.0 },
];

const MAX_GAP_MS = 2000;

const rule = (title: string) => console.log(`\n${title}\n${"-".repeat(title.length)}`);
const clock = (timestamp: string) => timestamp.slice(-13, -1);
const fixed = (value: number | null, digits = 4) =>
  value === null ? "n/a" : value.toFixed(digits);

// --- 1. the same target, asked too early and then late enough -------------- //
rule("1. The knowledge cutoff decides whether there is an answer at all");

for (const evaluation of ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.120Z"]) {
  const row = linearQuoteInterpolation(
    QUOTES,
    [{ ...P, target_time: "2026-01-01T00:00:01.000Z", evaluation_time: evaluation }],
    MAX_GAP_MS,
  )[0]!;
  const detail = row.bid === null ? `wait ${row.wait_ms}ms longer` : `bid=${row.bid}`;
  console.log(`  evaluated at ${clock(evaluation)}  ->  ${row.status.padEnd(22)}${detail}`);
}
console.log("  The right-hand endpoint had not arrived. There was no honest answer yet.");

// --- 2. interpolated is never observed ------------------------------------- //
rule("2. Interpolated is never observed");

const targets = [
  { ...P, target_time: "2026-01-01T00:00:00.000Z", evaluation_time: "2026-01-01T00:00:09Z" },
  { ...P, target_time: "2026-01-01T00:00:01.000Z", evaluation_time: "2026-01-01T00:00:09Z" },
];
for (const row of linearQuoteInterpolation(QUOTES, targets, MAX_GAP_MS)) {
  console.log(
    `  ${clock(row.target_time)}  ${row.status.padEnd(8)} bid=${String(row.bid).padEnd(7)} ` +
      `observable=${String(row.observable).padEnd(6)} interpolated=${row.interpolated}`,
  );
}
console.log("  Only the exact, already-arrived record is an observation. The other is arithmetic.");

// --- 3. how wrong is the straight line, on this data? ---------------------- //
rule("3. Leave-one-out: how wrong is the line here?");

// The only interior quote is bracketed by 00:00 and 00:03 — a 3000ms span. At the
// 2000ms budget that bracket is skipped, which is the sweep telling you the budget is
// doing real work rather than rubber-stamping.
const tight = interpolationError(QUOTES, MAX_GAP_MS).overall;
console.log(
  `  at maxGapMs=${MAX_GAP_MS}: checked ${tight.checked}, skipped ${tight.skipped} (bracket too wide)`,
);
const stats = interpolationError(QUOTES, 5000).overall;
console.log(`  at maxGapMs=5000: checked ${stats.checked} interior quote(s)`);
console.log(`    max absolute bid error: ${fixed(stats.max_abs_bid_error)}`);
console.log(`    worst error in spreads: ${fixed(stats.max_error_in_spreads)}`);
console.log("  Hidden each interior quote, rebuilt it from its neighbours, compared.");

// --- 4. what did honesty cost? --------------------------------------------- //
rule("4. Lookahead a revised-file backtest would have absorbed");

const cost = lookaheadCost(
  QUOTES,
  [{ ...P, target_time: "2026-01-01T00:00:01.000Z", evaluation_time: "2026-01-01T00:00:01.000Z" }],
  MAX_GAP_MS,
);
console.log(`  ${cost.summary.differing}/${cost.summary.total_targets} targets differ`);
for (const row of cost.rows) {
  console.log(
    `    honest=${row.point_in_time_status} (bid=${row.point_in_time_bid})  ` +
      `revised=${row.revised_status} (bid=${row.revised_bid})  wait=${row.wait_ms}ms`,
  );
}

// --- 5. where should the gap budget sit? ----------------------------------- //
rule("5. Gap profile");

const profile = gapProfile(QUOTES).overall;
console.log(
  `  ${profile.quotes} quotes, ${profile.gaps} gaps: min=${profile.min_ms}ms ` +
    `median=${profile.median_ms}ms max=${profile.max_ms}ms`,
);

// --- 6. the engine that waits ---------------------------------------------- //
rule("6. Interpolation has to wait, so the engine waits");

const live = new PendingInterpolator(MAX_GAP_MS);
live.observe(QUOTES[0]);
live.submit({ ...P, target_time: "2026-01-01T00:00:01.000Z" });
console.log(
  `  after 1 quote:  resolved=${live.resolve().length}  pending=${live.pendingCount} ` +
    `(${live.pending[0]!.status})`,
);

live.observe(QUOTES[1]);
const settled = live.resolve();
console.log(`  after 2 quotes: resolved=${settled.length}  pending=${live.pendingCount}`);
console.log(
  `  -> ${settled[0]!.status} bid=${settled[0]!.bid} ` +
    `first_knowable_at=${settled[0]!.first_knowable_at}`,
);

// --- 7. what is this batch actually made of? ------------------------------- //
rule("7. Measurement or model?");

const summary = statusSummary(linearQuoteInterpolation(QUOTES, targets, MAX_GAP_MS));
console.log(
  `  ${summary.observable} observed, ${summary.interpolated} interpolated, ` +
    `${summary.unresolved} unresolved  ` +
    `(observable share ${Math.round(summary.observable_share * 100)}%)`,
);
