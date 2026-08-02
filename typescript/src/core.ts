/**
 * Bitemporal linear interpolation for validated top-of-book quotes.
 *
 * This algorithm is the honest counterpart to previous-tick carry-forward, and the
 * difference between them is the whole point:
 *
 * **Linear interpolation reaches forward in time.** To value 10:00:01 it needs the
 * quote at 10:00:02. That quote had not happened yet at 10:00:01 and could not have
 * been known at 10:00:01, which means an interpolated value is **never** an observed
 * quote and must never be fed to anything pretending to run live. It is a research
 * construct — legal in a covariance estimate, fraudulent in a signal.
 *
 * This module therefore refuses to let you forget which one you are holding:
 *
 * - Every result carries `observable`. It is `true` only for an exactly-matching
 *   record that had already arrived. Every interpolated row is `observable: false`
 *   and `interpolated: true`.
 * - Every result carries `first_knowable_at` — the moment both endpoints had landed,
 *   which is the earliest a live system could have computed this number at all.
 * - Extrapolation is disabled. A target outside the observed range returns
 *   `unavailable` rather than a straight-line guess into a region with no right-hand
 *   anchor.
 *
 * ## Two clocks, as everywhere in this family
 *
 * `event_time` orders market events; `available_time` says when this process could
 * know the record; a target's `evaluation_time` is the point-in-time cutoff. An
 * endpoint that exists but had not arrived yields `left_not_available` /
 * `right_not_available` with a `wait_ms` telling you exactly how much longer you would
 * have had to wait — far more useful than a null, because it distinguishes "the data
 * is missing" from "you asked too early".
 *
 * ## The gap budget
 *
 * Interpolating across a two-second hole is arithmetic; across a twenty-minute hole it
 * is invention. `maxGapMs` draws that line and `gap_too_wide` reports crossing it,
 * with the measured `gap_ms` attached so the budget can be argued about with evidence.
 */

export interface Quote {
  instrument: string;
  venue: string;
  session_id: string;
  event_time: string;
  available_time: string;
  bid: number;
  ask: number;
}

export interface Target {
  instrument: string;
  venue: string;
  session_id: string;
  target_time: string;
  evaluation_time: string;
}

export type Status =
  | "exact"
  | "linear"
  | "exact_not_available"
  | "left_not_available"
  | "right_not_available"
  | "gap_too_wide"
  | "unavailable";

export interface Result {
  instrument: string;
  venue: string;
  session_id: string;
  target_time: string;
  evaluation_time: string;
  bid: number | null;
  ask: number | null;
  status: Status;
  reason: string;
  interpolated: boolean;
  observable: boolean;
  left_event_time: string | null;
  right_event_time: string | null;
  left_available_time: string | null;
  right_available_time: string | null;
  first_knowable_at: string | null;
  weight: number | null;
  gap_ms: number | null;
  wait_ms: number;
}

/** Every status this module can return, for exhaustive handling by callers. */
export const STATUSES: readonly Status[] = [
  "exact",
  "linear",
  "exact_not_available",
  "left_not_available",
  "right_not_available",
  "gap_too_wide",
  "unavailable",
];

/** RFC 3339 UTC, `Z` only, millisecond precision at most. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1]!;

/**
 * Days since 1970-01-01 for a proleptic-Gregorian date, by integer arithmetic.
 *
 * Deliberately not `Date.UTC`: that helper maps two-digit years into the 1900s and
 * accepts out-of-range days by rolling them over, both of which would let this port
 * disagree with the Python one.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Parse an RFC 3339 UTC timestamp to integer milliseconds since the epoch.
 *
 * Strict by design: `2026-02-30` is rejected rather than rolled over, which is what
 * keeps this port and the Python one agreeing on the same input.
 */
export function parseTimestampMs(value: unknown, field = "timestamp"): number {
  if (typeof value !== "string") {
    throw new Error(`${field} must be an RFC 3339 UTC timestamp ending in Z`);
  }
  const match = TIMESTAMP.exec(value);
  if (match === null) {
    throw new Error(
      `${field} must be an RFC 3339 UTC timestamp ending in Z ` +
        `(millisecond precision at most), got: ${JSON.stringify(value)}`,
    );
  }

  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const fraction = match[7] ?? "";
  const millisecond = fraction === "" ? 0 : Number(fraction.padEnd(3, "0"));

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new Error(`${field} is not a real calendar time: ${JSON.stringify(value)}`);
  }

  return (
    daysFromCivil(year, month, day) * 86_400_000 +
    (hour * 3600 + minute * 60 + second) * 1000 +
    millisecond
  );
}

/** Render integer milliseconds back to the RFC 3339 form this package accepts. */
export function formatTimestampMs(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export type PartitionKey = [string, string, string];

export function partitionOf(record: unknown): PartitionKey {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("each quote and target must be a mapping");
  }
  const source = record as Record<string, unknown>;
  const values = ["instrument", "venue", "session_id"].map((name) => source[name]);
  if (!values.every((value) => typeof value === "string" && value.trim() !== "")) {
    throw new Error("instrument, venue, and session_id must be non-empty strings");
  }
  return values as PartitionKey;
}

/**
 * Strictly a number, never a coerced string.
 *
 * `Number("100.5")` would succeed while Python's port rejects a string outright, so
 * accepting strings would make the two implementations disagree on the same input.
 */
function price(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("bid and ask must be finite numbers");
  }
  return value;
}

export interface NormalisedQuote {
  event_time: string;
  available_time: string;
  bid: number;
  ask: number;
  eventMs: number;
  availableMs: number;
}

interface Diagnostics {
  left_event_time?: string;
  right_event_time?: string;
  left_available_time?: string;
  right_available_time?: string;
  first_knowable_at?: string;
  gap_ms?: number;
  wait_ms?: number;
}

function empty(
  target: Record<string, unknown>,
  status: Status,
  reason: string,
  diagnostics: Diagnostics = {},
): Result {
  return {
    instrument: target.instrument as string,
    venue: target.venue as string,
    session_id: target.session_id as string,
    target_time: target.target_time as string,
    evaluation_time: target.evaluation_time as string,
    bid: null,
    ask: null,
    status,
    reason,
    interpolated: false,
    observable: false,
    left_event_time: diagnostics.left_event_time ?? null,
    right_event_time: diagnostics.right_event_time ?? null,
    left_available_time: diagnostics.left_available_time ?? null,
    right_available_time: diagnostics.right_available_time ?? null,
    first_knowable_at: diagnostics.first_knowable_at ?? null,
    weight: null,
    gap_ms: diagnostics.gap_ms ?? null,
    wait_ms: diagnostics.wait_ms ?? 0,
  };
}

export function normaliseQuotes(
  quotes: Iterable<unknown>,
): Map<string, NormalisedQuote[]> {
  const grouped = new Map<string, NormalisedQuote[]>();
  const seen = new Set<string>();

  for (const quote of quotes) {
    const key = partitionOf(quote).join("|");
    const source = quote as Record<string, unknown>;
    const eventMs = parseTimestampMs(source.event_time, "event_time");
    const availableMs = parseTimestampMs(source.available_time, "available_time");
    if (availableMs < eventMs) {
      throw new Error(
        "available_time must not precede event_time on the normalized clock",
      );
    }
    const bid = price(source, "bid");
    const ask = price(source, "ask");
    if (bid > ask) {
      // A crossed endpoint would produce an interpolated quote that is crossed for
      // part of the interval and not for the rest, which is not a quote.
      throw new Error("crossed endpoint quote: bid must not exceed ask");
    }

    const identity = `${key}|${eventMs}`;
    if (seen.has(identity)) {
      throw new Error(
        "duplicate event_time within an instrument/venue/session partition",
      );
    }
    seen.add(identity);

    const row: NormalisedQuote = {
      event_time: source.event_time as string,
      available_time: source.available_time as string,
      bid,
      ask,
      eventMs,
      availableMs,
    };
    const group = grouped.get(key);
    if (group) group.push(row);
    else grouped.set(key, [row]);
  }

  for (const rows of grouped.values()) rows.sort((a, b) => a.eventMs - b.eventMs);
  return grouped;
}

/**
 * Locate the insertion point for `targetMs` and whether it lands exactly.
 *
 * A plain binary search over the sorted event times.
 */
function bracket(
  rows: NormalisedQuote[],
  targetMs: number,
): { index: number; exact: boolean } {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle]!.eventMs < targetMs) low = middle + 1;
    else high = middle;
  }
  return { index: low, exact: low < rows.length && rows[low]!.eventMs === targetMs };
}

/**
 * Evaluate quote interpolation targets under an explicit knowledge cutoff.
 *
 * Never throws for a target that cannot be valued — that is reported as a status,
 * because a batch of research targets should not be aborted by one unreachable point.
 */
export function linearQuoteInterpolation(
  quotes: Iterable<unknown>,
  targets: Iterable<unknown>,
  maxGapMs: number,
): Result[] {
  if (typeof maxGapMs !== "number" || !Number.isInteger(maxGapMs) || maxGapMs <= 0) {
    throw new Error("max_gap_ms must be a positive integer");
  }

  const grouped = normaliseQuotes(quotes);

  const results: Result[] = [];
  for (const target of targets) {
    const key = partitionOf(target).join("|");
    const source = target as Record<string, unknown>;
    const targetMs = parseTimestampMs(source.target_time, "target_time");
    const evaluationMs = parseTimestampMs(source.evaluation_time, "evaluation_time");
    const rows = grouped.get(key);
    if (!rows || rows.length === 0) {
      results.push(empty(source, "unavailable", "no_partition"));
      continue;
    }

    const { index, exact } = bracket(rows, targetMs);

    if (exact) {
      const quote = rows[index]!;
      const waitMs = Math.max(0, quote.availableMs - evaluationMs);
      const shared: Diagnostics = {
        left_event_time: quote.event_time,
        right_event_time: quote.event_time,
        left_available_time: quote.available_time,
        right_available_time: quote.available_time,
        first_knowable_at: quote.available_time,
        gap_ms: 0,
      };
      if (waitMs) {
        results.push(
          empty(source, "exact_not_available", "exact_record_arrives_after_evaluation", {
            ...shared,
            wait_ms: waitMs,
          }),
        );
        continue;
      }
      results.push({
        ...empty(source, "exact", "observed_quote", shared),
        bid: quote.bid,
        ask: quote.ask,
        // The ONLY status that is a real observation rather than a construct.
        observable: true,
        weight: 0,
      });
      continue;
    }

    if (index === 0 || index === rows.length) {
      // No right-hand anchor (or no left one). Extrapolation is refused rather than
      // guessed: a straight line out of the observed range is a claim about a region
      // where nothing was measured.
      results.push(empty(source, "unavailable", "extrapolation_disabled"));
      continue;
    }

    const left = rows[index - 1]!;
    const right = rows[index]!;
    const gapMs = right.eventMs - left.eventMs;
    const diagnostics: Diagnostics = {
      left_event_time: left.event_time,
      right_event_time: right.event_time,
      left_available_time: left.available_time,
      right_available_time: right.available_time,
      // Compared on the parsed clock, NOT as strings: "…00.500Z" sorts before "…00Z"
      // lexicographically while being half a second later in fact.
      first_knowable_at: formatTimestampMs(Math.max(left.availableMs, right.availableMs)),
      gap_ms: gapMs,
    };

    if (gapMs > maxGapMs) {
      results.push(empty(source, "gap_too_wide", "maximum_gap_exceeded", diagnostics));
      continue;
    }
    if (left.availableMs > evaluationMs) {
      results.push(
        empty(source, "left_not_available", "left_endpoint_arrives_after_evaluation", {
          ...diagnostics,
          wait_ms: left.availableMs - evaluationMs,
        }),
      );
      continue;
    }
    if (right.availableMs > evaluationMs) {
      results.push(
        empty(source, "right_not_available", "right_endpoint_arrives_after_evaluation", {
          ...diagnostics,
          wait_ms: right.availableMs - evaluationMs,
        }),
      );
      continue;
    }

    const weight = (targetMs - left.eventMs) / gapMs;
    results.push({
      ...empty(source, "linear", "both_endpoints_available", diagnostics),
      bid: left.bid + weight * (right.bid - left.bid),
      ask: left.ask + weight * (right.ask - left.ask),
      interpolated: true,
      observable: false,
      weight,
    });
  }
  return results;
}
