/**
 * Contract tests for the interpolator.
 *
 * The fixture is the cross-language acceptance anchor: two quotes two seconds apart,
 * and five targets that between them hit `right_not_available`, `linear`,
 * `exact_not_available`, `exact` and `unavailable`. Its expected statuses are asserted
 * verbatim by this suite and by the Python one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { linearQuoteInterpolation, parseTimestampMs } from "../src/core.ts";
import { EXPECTED_STATUSES, MAX_GAP_MS, interpolate, quotes, targets } from "./fixtures.ts";

// --- the shared fixture ------------------------------------------------------- //
test("every status matches the fixture", () => {
  assert.deepEqual(interpolate().map((row) => row.status), EXPECTED_STATUSES);
});

test("one result per target in order", () => {
  const results = interpolate();
  assert.equal(results.length, targets().length);
  assert.deepEqual(
    results.map((row) => row.target_time),
    targets().map((target) => target.target_time),
  );
});

test("the fixture covers five distinct statuses", () => {
  assert.equal(new Set(EXPECTED_STATUSES).size, 5);
});

test("the interpolated midpoint is exact", () => {
  // Target at 00:01 sits halfway between 00:00 (99/101) and 00:02 (101/103).
  const row = interpolate()[1]!;
  assert.equal(row.status, "linear");
  assert.equal(row.weight, 0.5);
  assert.equal(row.bid, 100.0);
  assert.equal(row.ask, 102.0);
  assert.equal(row.gap_ms, 2000);
});

test("an empty target list produces nothing", () => {
  assert.deepEqual(interpolate(null, []), []);
});

test("no quotes means every target is unavailable", () => {
  const results = linearQuoteInterpolation([], targets(), MAX_GAP_MS);
  assert.deepEqual([...new Set(results.map((row) => row.status))], ["unavailable"]);
  assert.deepEqual([...new Set(results.map((row) => row.reason))], ["no_partition"]);
});

// --- observed versus constructed ---------------------------------------------- //
test("only an exact arrived record is observable", () => {
  // The whole safety story in one assertion.
  for (const row of interpolate()) {
    assert.equal(row.observable, row.status === "exact");
  }
});

test("an interpolated row is never observable", () => {
  const row = interpolate()[1]!;
  assert.equal(row.interpolated, true);
  assert.equal(row.observable, false);
});

test("an exact hit is not flagged as interpolated", () => {
  const row = interpolate()[3]!;
  assert.equal(row.status, "exact");
  assert.equal(row.interpolated, false);
  assert.equal(row.weight, 0);
  assert.equal(row.gap_ms, 0);
});

test("first_knowable_at is the later endpoint", () => {
  assert.equal(interpolate()[1]!.first_knowable_at, "2026-01-01T00:00:02.120Z");
});

test("first_knowable_at is compared on the clock not as strings", () => {
  // "…00.500Z" sorts BEFORE "…00Z" lexicographically while being later in fact.
  assert.ok("2026-01-01T00:00:02.500Z" < "2026-01-01T00:00:03Z"); // holds here…
  assert.ok("2026-01-01T00:00:00.500Z" > "2026-01-01T00:00:00Z" === false); // …but not here

  const rows = [
    { instrument: "A", venue: "X", session_id: "S",
      event_time: "2026-01-01T00:00:00Z", available_time: "2026-01-01T00:00:03Z",
      bid: 1.0, ask: 2.0 },
    { instrument: "A", venue: "X", session_id: "S",
      event_time: "2026-01-01T00:00:02Z", available_time: "2026-01-01T00:00:02.500Z",
      bid: 3.0, ask: 4.0 },
  ];
  const row = linearQuoteInterpolation(
    rows,
    [{ instrument: "A", venue: "X", session_id: "S",
       target_time: "2026-01-01T00:00:01Z", evaluation_time: "2026-01-01T00:00:09Z" }],
    MAX_GAP_MS,
  )[0]!;
  assert.equal(row.first_knowable_at, "2026-01-01T00:00:03.000Z");
});

// --- the knowledge cutoff ------------------------------------------------------ //
test("a right endpoint that has not arrived blocks the target", () => {
  const row = interpolate()[0]!;
  assert.equal(row.status, "right_not_available");
  assert.equal(row.bid, null);
  assert.equal(row.wait_ms, 1120);
});

test("the same target resolves once the endpoint lands", () => {
  const [early, late] = [interpolate()[0]!, interpolate()[1]!];
  assert.equal(early.target_time, late.target_time);
  assert.equal(early.status, "right_not_available");
  assert.equal(late.status, "linear");
});

test("an exact record that has not arrived is not used", () => {
  const row = interpolate()[2]!;
  assert.equal(row.status, "exact_not_available");
  assert.equal(row.bid, null);
  assert.equal(row.wait_ms, 100);
  assert.equal(row.first_knowable_at, "2026-01-01T00:00:00.100Z");
});

test("a settled row reports zero wait", () => {
  for (const row of interpolate()) {
    if (row.status === "exact" || row.status === "linear") assert.equal(row.wait_ms, 0);
  }
});

// --- extrapolation is refused --------------------------------------------------- //
test("a target before the first quote is unavailable", () => {
  const row = interpolate()[4]!;
  assert.equal(row.status, "unavailable");
  assert.equal(row.reason, "extrapolation_disabled");
});

test("a target after the last quote is unavailable", () => {
  const row = interpolate(null, [
    { instrument: "A", venue: "X", session_id: "S",
      target_time: "2026-01-01T00:00:05.000Z", evaluation_time: "2026-01-01T00:00:09.000Z" },
  ])[0]!;
  assert.equal(row.reason, "extrapolation_disabled");
});

test("an unknown partition is unavailable", () => {
  const row = interpolate(null, [
    { instrument: "ZZZ", venue: "X", session_id: "S",
      target_time: "2026-01-01T00:00:01.000Z", evaluation_time: "2026-01-01T00:00:09.000Z" },
  ])[0]!;
  assert.equal(row.reason, "no_partition");
});

// --- the gap budget -------------------------------------------------------------- //
test("a gap wider than the budget is refused", () => {
  const row = interpolate(null, null, 1999)[1]!;
  assert.equal(row.status, "gap_too_wide");
  assert.equal(row.gap_ms, 2000);
});

test("the budget boundary is inclusive", () => {
  assert.equal(interpolate(null, null, 2000)[1]!.status, "linear");
});

test("the gap budget is checked before availability", () => {
  // A target failing both should report the structural reason, not the timing one.
  assert.equal(interpolate(null, null, 1)[0]!.status, "gap_too_wide");
});

for (const bad of [0, -1, 1.5, "2000", true, null, NaN] as unknown[]) {
  test(`an invalid gap budget raises (${String(bad)})`, () => {
    assert.throws(
      () => linearQuoteInterpolation(quotes(), targets(), bad as number),
      /max_gap_ms/,
    );
  });
}

// --- partitioning ---------------------------------------------------------------- //
test("partitions do not bleed into each other", () => {
  const rows = quotes().map((row) => ({ ...row, venue: "Y" }));
  const result = linearQuoteInterpolation(rows, targets(1), MAX_GAP_MS)[0]!;
  assert.equal(result.reason, "no_partition");
});

test("two partitions are interpolated independently", () => {
  const rows = [
    ...quotes(),
    ...quotes().map((row) => ({ ...row, venue: "Y", bid: row.bid + 10, ask: row.ask + 10 })),
  ];
  const points = [...targets(1), { ...targets(1)[0]!, venue: "Y" }];
  const results = linearQuoteInterpolation(rows, points, MAX_GAP_MS);
  assert.equal(results[0]!.bid, 100.0);
  assert.equal(results[1]!.bid, 110.0);
});

test("a duplicate event_time in one partition raises", () => {
  assert.throws(() => interpolate(quotes(0, 0)), /duplicate event_time/);
});

test("quote order does not change the answer", () => {
  assert.deepEqual(interpolate(), interpolate([...quotes()].reverse()));
});

// --- validation ------------------------------------------------------------------ //
for (const field of ["instrument", "venue", "session_id"]) {
  for (const value of ["", "   ", 7, null] as unknown[]) {
    test(`a bad ${field} raises (${String(value)})`, () => {
      const rows = quotes(0) as unknown as Array<Record<string, unknown>>;
      rows[0]![field] = value;
      assert.throws(() => interpolate(rows), /non-empty strings/);
    });
  }
}

for (const value of ["100", null, true, NaN, Infinity] as unknown[]) {
  test(`a non-numeric price raises (${String(value)})`, () => {
    // Number("100") would succeed; Python refuses a string outright. So do we.
    const rows = quotes(0) as unknown as Array<Record<string, unknown>>;
    rows[0]!.bid = value;
    assert.throws(() => interpolate(rows), /finite numbers/);
  });
}

test("a crossed endpoint raises", () => {
  const rows = quotes(0);
  rows[0]!.bid = 101.0;
  rows[0]!.ask = 99.0;
  assert.throws(() => interpolate(rows), /crossed endpoint/);
});

test("a locked endpoint is allowed", () => {
  const rows = quotes();
  rows[0]!.bid = rows[0]!.ask;
  assert.equal(interpolate(rows)[1]!.status, "linear");
});

test("available before event raises", () => {
  const rows = quotes(0);
  rows[0]!.available_time = "2025-12-31T00:00:00.000Z";
  assert.throws(() => interpolate(rows), /must not precede event_time/);
});

test("input rows are never mutated", () => {
  const rows = quotes();
  const points = targets();
  const before = JSON.stringify([rows, points]);
  linearQuoteInterpolation(rows, points, MAX_GAP_MS);
  assert.equal(JSON.stringify([rows, points]), before);
});

// --- timestamps are strict --------------------------------------------------------- //
test("an impossible calendar date is rejected", () => {
  assert.throws(() => parseTimestampMs("2026-02-30T00:00:00.000Z"), /not a real calendar time/);
  assert.equal(new Date("2026-02-30T00:00:00.000Z").getUTCMonth(), 2); // proof of the rollover
});

test("a leap day is accepted in a leap year and refused otherwise", () => {
  assert.ok(parseTimestampMs("2024-02-29T00:00:00Z") > 0);
  assert.throws(() => parseTimestampMs("2026-02-29T00:00:00Z"), /not a real calendar time/);
});

for (const timestamp of [
  "2026-01-01T00:00:00+00:00",
  "2026-01-01T00:00:00",
  "2026-01-01T00:00:00.0001Z",
  "2026-13-01T00:00:00Z",
  "",
  null,
  1767225600000,
] as unknown[]) {
  test(`a malformed timestamp is rejected (${JSON.stringify(timestamp)})`, () => {
    assert.throws(() => parseTimestampMs(timestamp));
  });
}

for (const [timestamp, expected] of [
  ["1970-01-01T00:00:00Z", 0],
  ["1970-01-01T00:00:00.001Z", 1],
  ["2026-01-01T00:00:02.120Z", 1_767_225_602_120],
] as Array<[string, number]>) {
  test(`a valid timestamp parses exactly (${timestamp})`, () => {
    assert.equal(parseTimestampMs(timestamp), expected);
  });
}

test("a second-precision timestamp is accepted", () => {
  const rows = quotes();
  rows[0]!.event_time = "2026-01-01T00:00:00Z";
  assert.equal(interpolate(rows)[1]!.status, "linear");
});
