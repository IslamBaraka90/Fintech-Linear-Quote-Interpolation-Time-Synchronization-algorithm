/**
 * Tests for the engine that waits.
 *
 * The point being pinned: a target submitted before its right-hand endpoint exists
 * must NOT produce a number. It stays pending, and it resolves only once the data
 * behind it genuinely arrived.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PendingInterpolator } from "../src/pending.ts";
import { MAX_GAP_MS, interpolate, quotes } from "./fixtures.ts";

const TARGET = {
  instrument: "A",
  venue: "X",
  session_id: "S",
  target_time: "2026-01-01T00:00:01.000Z",
};

const engine = (resolveUnavailable = false) =>
  new PendingInterpolator(MAX_GAP_MS, resolveUnavailable);

// --- waiting is the whole point ------------------------------------------------- //
test("a target does not resolve before its right endpoint", () => {
  const live = engine();
  live.observe(quotes(0)[0]);
  live.submit(TARGET);
  assert.deepEqual(live.resolve(), []);
  assert.equal(live.pendingCount, 1);
});

test("it resolves the moment the endpoint lands", () => {
  const live = engine();
  live.observe(quotes(0)[0]);
  live.submit(TARGET);
  live.resolve();
  live.observe(quotes(1)[0]);

  const settled = live.resolve();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.status, "linear");
  assert.equal(settled[0]!.bid, 100.0);
  assert.equal(live.pendingCount, 0);
});

test("a resolved target is not returned twice", () => {
  const live = engine();
  live.observeMany(quotes());
  live.submit(TARGET);
  assert.equal(live.resolve().length, 1);
  assert.deepEqual(live.resolve(), []);
});

test("the result matches the batch function", () => {
  // The live path and the research path must not be two different algorithms.
  const live = engine();
  live.observeMany(quotes());
  live.submit(TARGET);
  const settled = live.resolve()[0]!;
  const batch = interpolate(null, [
    { ...TARGET, evaluation_time: live.knowledgeTime },
  ])[0]!;
  assert.deepEqual(settled, batch);
});

test("pending says why it is waiting", () => {
  const live = engine();
  live.observe(quotes(0)[0]);
  live.submit(TARGET);
  assert.ok(["unavailable", "right_not_available"].includes(live.pending[0]!.status));
});

test("pending before any quote is explicit", () => {
  const live = engine();
  live.submit(TARGET);
  assert.equal(live.pending[0]!.status, "no_quotes_yet");
  assert.deepEqual(live.resolve(), []);
});

// --- the knowledge clock ---------------------------------------------------------- //
test("the clock is the latest arrival", () => {
  const live = engine();
  live.observeMany(quotes());
  assert.equal(live.knowledgeTime, "2026-01-01T00:00:02.120Z");
});

test("the clock only moves on ingestion", () => {
  const live = engine();
  live.observe(quotes(0)[0]);
  const before = live.knowledgeTime;
  live.submit(TARGET);
  live.resolve();
  assert.equal(live.knowledgeTime, before);
});

test("reading the clock before any quote raises", () => {
  assert.throws(() => engine().knowledgeTime, /no quotes/);
});

test("out-of-order arrival is rejected", () => {
  const live = engine();
  live.observe(quotes(1)[0]);
  assert.throws(() => live.observe(quotes(0)[0]), /non-decreasing available_time/);
});

test("simultaneous arrivals are allowed", () => {
  const live = engine();
  live.observeMany([quotes(0)[0]!, { ...quotes(0)[0]!, venue: "Y" }]);
  assert.equal(live.retained, 2);
});

// --- settled versus waiting -------------------------------------------------------- //
test("an exact arrived record settles immediately", () => {
  const live = engine();
  live.observe(quotes(0)[0]);
  live.submit({ ...TARGET, target_time: "2026-01-01T00:00:00.000Z" });
  const settled = live.resolve();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.status, "exact");
  assert.equal(settled[0]!.observable, true);
});

test("a gap that is too wide settles rather than waits", () => {
  // No amount of waiting will narrow the gap, so holding the target would lie.
  const live = new PendingInterpolator(1);
  live.observeMany(quotes());
  live.submit(TARGET);
  const settled = live.resolve();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.status, "gap_too_wide");
});

test("an unavailable target is held by default", () => {
  // Early in a session "unavailable" usually means "not yet", not "never".
  const live = engine();
  live.observe(quotes(0)[0]);
  live.submit({ ...TARGET, target_time: "2026-01-01T00:00:01.500Z" });
  assert.deepEqual(live.resolve(), []);
});

test("unavailable can be settled on request", () => {
  const live = engine(true);
  live.observe(quotes(0)[0]);
  live.submit({ ...TARGET, target_time: "2026-01-01T00:00:01.500Z" });
  const settled = live.resolve();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.status, "unavailable");
});

// --- bookkeeping -------------------------------------------------------------------- //
test("many targets resolve independently", () => {
  const live = engine();
  live.observe(quotes(0)[0]);
  live.submitMany([TARGET, { ...TARGET, target_time: "2026-01-01T00:00:00.000Z" }]);
  assert.deepEqual(live.resolve().map((row) => row.status), ["exact"]);
  live.observe(quotes(1)[0]);
  assert.deepEqual(live.resolve().map((row) => row.status), ["linear"]);
});

test("retained counts the quotes held", () => {
  const live = engine();
  live.observeMany(quotes());
  assert.equal(live.retained, 2);
});

test("a bad quote is rejected at ingestion", () => {
  const live = engine();
  const bad = quotes(0)[0] as unknown as Record<string, unknown>;
  bad.bid = "100";
  assert.throws(() => live.observe(bad), /finite numbers/);
  assert.equal(live.retained, 0);
});

test("a bad target is rejected at submission", () => {
  const live = engine();
  assert.throws(() => live.submit({ ...TARGET, target_time: "not-a-time" }));
  assert.equal(live.pendingCount, 0);
});

for (const bad of [0, -1, 1.5, "2000", null] as unknown[]) {
  test(`a bad budget raises (${String(bad)})`, () => {
    assert.throws(() => new PendingInterpolator(bad as number), /max_gap_ms/);
  });
}
