/**
 * How wrong is the straight line, and how much did the two clocks cost?
 *
 * The core module tells you *what* the interpolated value is. This module tells you
 * whether you should have used it — a different question, and the one that gets
 * skipped.
 *
 * **How wrong is the line?** — {@link interpolationError}
 * Leave-one-out validation on your own data. For every interior quote, hide it,
 * interpolate its event time from its two neighbours, and compare against what was
 * actually there. The result is an empirical error distribution for exactly the
 * instrument, venue and session you are about to interpolate — the honest answer to
 * "is linear good enough here", for one pass over data you already have.
 *
 * **What did point-in-time honesty cost?** — {@link lookaheadCost}
 * Evaluates every target twice: once respecting `evaluation_time`, and once the way a
 * revised historical file lets you cheat, with every record treated as instantly
 * available. The difference is the set of values a naive pipeline would have produced
 * and a live system never could.
 *
 * **Where should the gap budget sit?** — {@link gapProfile}
 * The observed distribution of inter-quote gaps per partition. A `maxGapMs` below the
 * median means most targets return `gap_too_wide`; one above the maximum is not doing
 * anything. Both are worth knowing before the number is hard-coded.
 */

import {
  STATUSES,
  type Result,
  type Status,
  linearQuoteInterpolation,
  normaliseQuotes,
} from "./core.ts";

export interface ErrorStats {
  checked: number;
  skipped: number;
  mean_abs_bid_error: number | null;
  mean_abs_ask_error: number | null;
  max_abs_bid_error: number | null;
  max_abs_ask_error: number | null;
  max_error_in_spreads: number | null;
}

export interface GapStats {
  quotes: number;
  gaps: number;
  min_ms: number | null;
  median_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface LookaheadRow {
  instrument: string;
  venue: string;
  session_id: string;
  target_time: string;
  evaluation_time: string;
  point_in_time_status: Status;
  revised_status: Status;
  point_in_time_bid: number | null;
  revised_bid: number | null;
  point_in_time_ask: number | null;
  revised_ask: number | null;
  wait_ms: number;
  first_knowable_at: string | null;
}

export interface StatusSummary {
  total: number;
  counts: Record<string, number>;
  observable: number;
  interpolated: number;
  observable_share: number;
  unresolved: number;
}

const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

/** Nearest-rank percentile. Deliberately simple, and identical in both ports. */
const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) throw new Error("percentile of an empty sequence");
  const ordered = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.min(ordered.length, Math.round(fraction * ordered.length + 0.5)));
  return ordered[Math.min(ordered.length - 1, Math.max(0, rank - 1))]!;
};

interface ErrorPoint {
  event_time: string;
  bid_error: number;
  ask_error: number;
  spread: number;
  gap_ms: number;
}

function errorStats(points: ErrorPoint[], skipped: number): ErrorStats {
  if (points.length === 0) {
    return {
      checked: 0,
      skipped,
      mean_abs_bid_error: null,
      mean_abs_ask_error: null,
      max_abs_bid_error: null,
      max_abs_ask_error: null,
      max_error_in_spreads: null,
    };
  }

  const bidErrors = points.map((point) => Math.abs(point.bid_error));
  const askErrors = points.map((point) => Math.abs(point.ask_error));
  // Expressed in spreads because an absolute price error means nothing on its own:
  // 0.01 is enormous on a 0.005-wide book and invisible on a 5.00-wide one.
  const inSpreads = points
    .filter((point) => point.spread > 0)
    .map((point) => Math.max(Math.abs(point.bid_error), Math.abs(point.ask_error)) / point.spread);

  return {
    checked: points.length,
    skipped,
    mean_abs_bid_error: mean(bidErrors),
    mean_abs_ask_error: mean(askErrors),
    max_abs_bid_error: Math.max(...bidErrors),
    max_abs_ask_error: Math.max(...askErrors),
    max_error_in_spreads: inSpreads.length ? Math.max(...inSpreads) : null,
  };
}

/**
 * Leave-one-out validation of the straight line against the data itself.
 *
 * Brackets wider than `maxGapMs` are skipped, because those are the ones the core
 * module would refuse anyway. `max_error_in_spreads` is the form that tells you
 * whether the error matters: half a tick is noise, two spreads means the line is
 * inventing a price level that never traded.
 */
export function interpolationError(
  quotes: Iterable<unknown>,
  maxGapMs: number,
): { partitions: Record<string, ErrorStats>; overall: ErrorStats } {
  if (typeof maxGapMs !== "number" || !Number.isInteger(maxGapMs) || maxGapMs <= 0) {
    throw new Error("max_gap_ms must be a positive integer");
  }

  const grouped = normaliseQuotes(quotes);
  const partitions: Record<string, ErrorStats> = {};
  const allPoints: ErrorPoint[] = [];
  let totalSkipped = 0;

  for (const key of [...grouped.keys()].sort()) {
    const rows = grouped.get(key)!;
    const points: ErrorPoint[] = [];
    let skipped = 0;
    for (let index = 1; index < rows.length - 1; index += 1) {
      const left = rows[index - 1]!;
      const actual = rows[index]!;
      const right = rows[index + 1]!;
      const gapMs = right.eventMs - left.eventMs;
      if (gapMs > maxGapMs || gapMs === 0) {
        skipped += 1;
        continue;
      }
      const weight = (actual.eventMs - left.eventMs) / gapMs;
      points.push({
        event_time: actual.event_time,
        bid_error: left.bid + weight * (right.bid - left.bid) - actual.bid,
        ask_error: left.ask + weight * (right.ask - left.ask) - actual.ask,
        spread: actual.ask - actual.bid,
        gap_ms: gapMs,
      });
    }
    partitions[key] = errorStats(points, skipped);
    allPoints.push(...points);
    totalSkipped += skipped;
  }

  // The roll-up must carry the skips too: "checked 0, skipped 0" would read as
  // "there was nothing to check" when in fact every bracket was refused.
  return { partitions, overall: errorStats(allPoints, totalSkipped) };
}

/**
 * Compare point-in-time evaluation against the revised-file view.
 *
 * The naive view sets every `evaluation_time` far into the future, so every record
 * looks instantly available — exactly what reading a corrected historical file gives
 * you. Any target that becomes valuable only under that view is one a live system
 * could never have produced. `wait_ms` is the actionable number: how much later the
 * decision would have had to be taken for the value to be real.
 */
export function lookaheadCost(
  quotes: Iterable<unknown>,
  targets: Iterable<unknown>,
  maxGapMs: number,
): {
  summary: {
    total_targets: number;
    differing: number;
    differing_share: number;
    max_wait_ms: number | null;
    median_wait_ms: number | null;
  };
  rows: LookaheadRow[];
} {
  const quoteList = [...quotes];
  const targetList = [...targets] as Array<Record<string, unknown>>;

  const honest = linearQuoteInterpolation(quoteList, targetList, maxGapMs);
  // A cutoff after every available_time in the batch: the revised-file view.
  const naive = linearQuoteInterpolation(
    quoteList,
    targetList.map((target) => ({
      ...target,
      evaluation_time: "9999-12-31T23:59:59.999Z",
    })),
    maxGapMs,
  );

  const rows: LookaheadRow[] = [];
  honest.forEach((honestRow: Result, index: number) => {
    const naiveRow = naive[index]!;
    if (honestRow.status === naiveRow.status) return;
    rows.push({
      instrument: honestRow.instrument,
      venue: honestRow.venue,
      session_id: honestRow.session_id,
      target_time: honestRow.target_time,
      evaluation_time: honestRow.evaluation_time,
      point_in_time_status: honestRow.status,
      revised_status: naiveRow.status,
      point_in_time_bid: honestRow.bid,
      revised_bid: naiveRow.bid,
      point_in_time_ask: honestRow.ask,
      revised_ask: naiveRow.ask,
      wait_ms: honestRow.wait_ms,
      first_knowable_at: naiveRow.first_knowable_at,
    });
  });

  const waits = rows.map((row) => row.wait_ms).filter((wait) => wait > 0);
  return {
    summary: {
      total_targets: honest.length,
      differing: rows.length,
      differing_share: honest.length ? rows.length / honest.length : 0,
      max_wait_ms: waits.length ? Math.max(...waits) : null,
      median_wait_ms: waits.length ? median(waits) : null,
    },
    rows,
  };
}

function gapStats(gaps: number[], quoteCount: number): GapStats {
  if (gaps.length === 0) {
    return { quotes: quoteCount, gaps: 0, min_ms: null, median_ms: null, p95_ms: null, max_ms: null };
  }
  return {
    quotes: quoteCount,
    gaps: gaps.length,
    min_ms: Math.min(...gaps),
    median_ms: median(gaps),
    p95_ms: percentile(gaps, 0.95),
    max_ms: Math.max(...gaps),
  };
}

/**
 * Distribution of inter-quote gaps per partition, for choosing `maxGapMs`.
 *
 * A budget below the median makes most targets `gap_too_wide`; a budget above the
 * maximum is not constraining anything. The useful settings live between the two.
 */
export function gapProfile(quotes: Iterable<unknown>): {
  partitions: Record<string, GapStats>;
  overall: GapStats;
} {
  const grouped = normaliseQuotes(quotes);
  const partitions: Record<string, GapStats> = {};
  const allGaps: number[] = [];
  let totalQuotes = 0;

  for (const key of [...grouped.keys()].sort()) {
    const rows = grouped.get(key)!;
    const gaps: number[] = [];
    for (let index = 1; index < rows.length; index += 1) {
      gaps.push(rows[index]!.eventMs - rows[index - 1]!.eventMs);
    }
    partitions[key] = gapStats(gaps, rows.length);
    allGaps.push(...gaps);
    totalQuotes += rows.length;
  }

  return { partitions, overall: gapStats(allGaps, totalQuotes) };
}

/** Roll up a batch of results by status, separating observed from constructed. */
export function statusSummary(results: Iterable<unknown>): StatusSummary {
  const rows = [...results] as Array<Record<string, unknown>>;
  rows.forEach((row, index) => {
    if (row === null || typeof row !== "object" || !("status" in row)) {
      throw new Error(`results[${index}] must come from linearQuoteInterpolation()`);
    }
  });

  const counts: Record<string, number> = {};
  for (const status of STATUSES) counts[status] = 0;
  for (const row of rows) {
    const status = String(row.status);
    counts[status] = (counts[status] ?? 0) + 1;
  }

  const observable = rows.filter((row) => row.observable === true).length;
  const interpolated = rows.filter((row) => row.interpolated === true).length;

  return {
    total: rows.length,
    counts,
    // The distinction that matters: how much of this batch is measurement and how
    // much is arithmetic. A research set that is 95% interpolated is a model output,
    // whatever the column headers say.
    observable,
    interpolated,
    observable_share: rows.length ? observable / rows.length : 0,
    unresolved: rows.length - observable - interpolated,
  };
}
