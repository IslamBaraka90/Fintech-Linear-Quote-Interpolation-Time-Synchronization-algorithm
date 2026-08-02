/** Tests for leave-one-out error, lookahead cost, gap profiling and the roll-up. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { linearQuoteInterpolation } from "../src/core.ts";
import {
  gapProfile,
  interpolationError,
  lookaheadCost,
  statusSummary,
} from "../src/leakage.ts";
import { MAX_GAP_MS, interpolate, quotes, targets } from "./fixtures.ts";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** A single-partition quote series with a given bid path. */
const series = (values: number[], stepMs = 1000, spread = 2.0) =>
  values.map((value, index) => {
    const ms = index * stepMs;
    const stamp = `2026-01-01T00:00:${pad(Math.floor(ms / 1000), 2)}.${pad(ms % 1000, 3)}Z`;
    return {
      instrument: "A", venue: "X", session_id: "S",
      event_time: stamp, available_time: stamp,
      bid: value, ask: value + spread,
    };
  });

// --- interpolationError -------------------------------------------------------- //
test("a perfectly linear series has zero error", () => {
  const stats = interpolationError(series([10, 11, 12, 13, 14]), 5000).overall;
  assert.equal(stats.checked, 3);
  assert.ok(close(stats.max_abs_bid_error!, 0));
  assert.ok(close(stats.mean_abs_ask_error!, 0));
});

test("a kinked series has measurable error", () => {
  // A V shape is where linear interpolation lies the most.
  const stats = interpolationError(series([10, 20, 10]), 5000).overall;
  assert.equal(stats.checked, 1);
  assert.ok(close(stats.max_abs_bid_error!, 10));
});

test("the error is also expressed in spreads", () => {
  const stats = interpolationError(series([10, 20, 10], 1000, 2.0), 5000).overall;
  assert.ok(close(stats.max_error_in_spreads!, 5));
});

test("a wide bracket is skipped not counted", () => {
  const stats = interpolationError(series([10, 20, 10]), 1).overall;
  assert.equal(stats.checked, 0);
  assert.equal(stats.max_abs_bid_error, null);
});

test("the roll-up carries the skip count", () => {
  // "checked 0, skipped 0" would read as "nothing to check" rather than "every
  // bracket was refused" — two very different statements.
  const result = interpolationError(series([10, 20, 10, 30]), 1);
  assert.equal(result.overall.checked, 0);
  assert.equal(result.overall.skipped, 2);
  assert.equal(
    result.overall.skipped,
    Object.values(result.partitions).reduce((sum, stats) => sum + stats.skipped, 0),
  );
});

test("endpoints are never checked", () => {
  assert.equal(interpolationError(series([10, 11]), 5000).overall.checked, 0);
});

test("a single quote yields nothing to check", () => {
  assert.equal(interpolationError(series([10]), 5000).overall.checked, 0);
});

test("partitions are reported separately", () => {
  const rows = [
    ...series([10, 11, 12]),
    ...series([10, 20, 10]).map((row) => ({ ...row, venue: "Y" })),
  ];
  const result = interpolationError(rows, 5000);
  assert.ok(close(result.partitions["A|X|S"]!.max_abs_bid_error!, 0));
  assert.ok(close(result.partitions["A|Y|S"]!.max_abs_bid_error!, 10));
  assert.equal(result.overall.checked, 2);
});

for (const bad of [0, -1, 1.5, "5000"] as unknown[]) {
  test(`a bad budget raises (${String(bad)})`, () => {
    assert.throws(
      () => interpolationError(series([10, 11, 12]), bad as number),
      /max_gap_ms/,
    );
  });
}

// --- lookaheadCost -------------------------------------------------------------- //
test("the lookahead finds the targets that needed the future", () => {
  assert.ok(lookaheadCost(quotes(), targets(), MAX_GAP_MS).summary.differing > 0);
});

test("a blocked target becomes valuable under the revised view", () => {
  const row = lookaheadCost(quotes(), targets(0), MAX_GAP_MS).rows[0]!;
  assert.equal(row.point_in_time_status, "right_not_available");
  assert.equal(row.revised_status, "linear");
  assert.equal(row.point_in_time_bid, null);
  assert.equal(row.revised_bid, 100.0);
});

test("the wait is the actionable number", () => {
  const result = lookaheadCost(quotes(), targets(0), MAX_GAP_MS);
  assert.equal(result.rows[0]!.wait_ms, 1120);
  assert.equal(result.summary.max_wait_ms, 1120);
});

test("a target evaluated late enough costs nothing", () => {
  const result = lookaheadCost(quotes(), targets(1), MAX_GAP_MS);
  assert.deepEqual(result.rows, []);
  assert.equal(result.summary.differing, 0);
  assert.equal(result.summary.max_wait_ms, null);
});

test("the share is over every target", () => {
  const result = lookaheadCost(quotes(), targets(), MAX_GAP_MS);
  assert.equal(result.summary.total_targets, targets().length);
  assert.ok(
    close(result.summary.differing_share, result.summary.differing / targets().length),
  );
});

test("a structurally impossible target is not lookahead", () => {
  // Extrapolation stays unavailable in both views, so it must not be counted.
  assert.deepEqual(lookaheadCost(quotes(), targets(4), MAX_GAP_MS).rows, []);
});

test("the revised view reports when the value became knowable", () => {
  const row = lookaheadCost(quotes(), targets(0), MAX_GAP_MS).rows[0]!;
  assert.equal(row.first_knowable_at, "2026-01-01T00:00:02.120Z");
});

// --- gapProfile ----------------------------------------------------------------- //
test("the gap profile measures the spacing", () => {
  const profile = gapProfile(series([1, 2, 3, 4, 5])).overall;
  assert.equal(profile.quotes, 5);
  assert.equal(profile.gaps, 4);
  assert.equal(profile.min_ms, 1000);
  assert.equal(profile.max_ms, 1000);
  assert.equal(profile.median_ms, 1000);
});

test("an uneven series shows its worst gap", () => {
  const rows = series([1, 2, 3]);
  rows[2]!.event_time = "2026-01-01T00:00:09.000Z";
  rows[2]!.available_time = "2026-01-01T00:00:09.000Z";
  // Events now sit at 00.000, 01.000, 09.000 — gaps of 1000ms and 8000ms.
  const profile = gapProfile(rows).overall;
  assert.equal(profile.min_ms, 1000);
  assert.equal(profile.max_ms, 8000);
});

test("a single quote has no gaps", () => {
  const profile = gapProfile(series([1])).overall;
  assert.equal(profile.gaps, 0);
  assert.equal(profile.median_ms, null);
});

test("the profile separates partitions", () => {
  const rows = [...series([1, 2, 3]), ...series([1, 2]).map((row) => ({ ...row, venue: "Y" }))];
  const profile = gapProfile(rows);
  assert.equal(profile.partitions["A|X|S"]!.gaps, 2);
  assert.equal(profile.partitions["A|Y|S"]!.gaps, 1);
});

test("the profile bounds a sensible budget", () => {
  // The whole point: a budget below the median refuses most brackets.
  const rows = series([1, 2, 3, 4]);
  const profile = gapProfile(rows).overall;
  assert.equal(interpolationError(rows, profile.median_ms! - 1).overall.checked, 0);
  assert.equal(interpolationError(rows, profile.max_ms! * 3).overall.checked, 2);
});

// --- statusSummary --------------------------------------------------------------- //
test("the summary counts every status", () => {
  const summary = statusSummary(interpolate());
  assert.equal(summary.total, 5);
  assert.equal(summary.counts.linear, 1);
  assert.equal(summary.counts.exact, 1);
  assert.equal(summary.counts.unavailable, 1);
});

test("observed and constructed are separated", () => {
  const summary = statusSummary(interpolate());
  assert.equal(summary.observable, 1);
  assert.equal(summary.interpolated, 1);
  assert.equal(summary.unresolved, 3);
});

test("the observable share is over the whole batch", () => {
  assert.ok(close(statusSummary(interpolate()).observable_share, 1 / 5));
});

test("an empty batch summarises to zero", () => {
  const summary = statusSummary([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.observable_share, 0);
});

test("every known status appears in the counts", () => {
  const counts = statusSummary(interpolate()).counts;
  for (const status of ["exact", "linear", "gap_too_wide", "unavailable"]) {
    assert.ok(status in counts);
  }
});

test("the summary rejects foreign rows", () => {
  assert.throws(() => statusSummary([{ nope: 1 }]), /linearQuoteInterpolation/);
});

test("the summary agrees with a direct count", () => {
  const results = linearQuoteInterpolation(quotes(), targets(), MAX_GAP_MS);
  assert.equal(
    statusSummary(results).counts.linear,
    results.filter((row) => row.status === "linear").length,
  );
});
