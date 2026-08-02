/** Shared fixture access. The same JSON backs the Python suite. */

import { createRequire } from "node:module";

import {
  linearQuoteInterpolation,
  type Quote,
  type Result,
  type Target,
} from "../src/core.ts";

const require = createRequire(import.meta.url);
const FIXTURE = require("./fixtures/fixtures.json") as {
  max_gap_ms: number;
  quotes: Quote[];
  targets: Target[];
  expected_statuses: string[];
};

export const MAX_GAP_MS = FIXTURE.max_gap_ms;
export const QUOTES = FIXTURE.quotes;
export const TARGETS = FIXTURE.targets;
export const EXPECTED_STATUSES = FIXTURE.expected_statuses;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Deep-copied fixture quotes — all, or the given 0-based positions. */
export const quotes = (...indexes: number[]): Quote[] =>
  indexes.length === 0 ? clone(QUOTES) : indexes.map((index) => clone(QUOTES[index]!));

/** Deep-copied fixture targets — all, or the given 0-based positions. */
export const targets = (...indexes: number[]): Target[] =>
  indexes.length === 0 ? clone(TARGETS) : indexes.map((index) => clone(TARGETS[index]!));

export const interpolate = (
  rows?: unknown[] | null,
  points?: unknown[] | null,
  maxGapMs?: number,
): Result[] =>
  linearQuoteInterpolation(rows ?? quotes(), points ?? targets(), maxGapMs ?? MAX_GAP_MS);
