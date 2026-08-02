/**
 * Interpolation that waits, because interpolation genuinely has to.
 *
 * There is no streaming linear interpolation, and pretending otherwise is how
 * lookahead gets into a pipeline. To value 10:00:01 the algorithm needs the quote at
 * 10:00:02, so at 10:00:01 the answer does not exist yet. Any "live interpolator" that
 * returns a number at 10:00:01 is returning a number it could not have.
 *
 * So this engine does the only honest thing: it **holds the target open**. You submit
 * a target, it stays pending, and it resolves the moment both bracketing endpoints
 * have arrived — no earlier. {@link PendingInterpolator.pending} is not a queue of
 * failures; it is an accurate statement of what is not yet knowable.
 *
 * The engine's knowledge clock is the latest `available_time` it has ingested. Feeding
 * it a quote is the only thing that moves that clock forward, which is exactly how a
 * real consumer experiences time.
 */

import {
  type Result,
  formatTimestampMs,
  linearQuoteInterpolation,
  parseTimestampMs,
  partitionOf,
} from "./core.ts";

/** Statuses that mean "come back later", as opposed to a settled answer. */
const WAITING = new Set([
  "left_not_available",
  "right_not_available",
  "exact_not_available",
  "unavailable",
]);

export interface PendingEntry extends Record<string, unknown> {
  status: string;
  wait_ms?: number;
}

/** Submit targets, ingest quotes, collect results only once they are knowable. */
export class PendingInterpolator {
  readonly #maxGapMs: number;
  readonly #resolveUnavailable: boolean;
  #quotes: Array<Record<string, unknown>> = [];
  #targets: Array<Record<string, unknown>> = [];
  #knowledgeMs: number | null = null;
  #lastAvailableMs: number | null = null;

  /**
   * @param maxGapMs Widest bracketing interval that may be interpolated across.
   * @param resolveUnavailable When `true`, a target that currently reports
   *   `unavailable` (no bracketing pair yet) settles immediately instead of being
   *   held. Defaults to `false`, because early in a session `unavailable` usually
   *   means "the right-hand quote has not happened yet" rather than "it never will".
   */
  constructor(maxGapMs: number, resolveUnavailable = false) {
    if (typeof maxGapMs !== "number" || !Number.isInteger(maxGapMs) || maxGapMs <= 0) {
      throw new Error("max_gap_ms must be a positive integer");
    }
    this.#maxGapMs = maxGapMs;
    this.#resolveUnavailable = resolveUnavailable;
  }

  // --- ingestion ---------------------------------------------------------- //
  /** Ingest one quote. Must not arrive before the previous one. */
  observe(quote: unknown): void {
    partitionOf(quote);
    const source = quote as Record<string, unknown>;
    const availableMs = parseTimestampMs(source.available_time, "available_time");
    if (this.#lastAvailableMs !== null && availableMs < this.#lastAvailableMs) {
      throw new Error("quotes must arrive in non-decreasing available_time order");
    }

    // Validate the rest by running it through the normaliser, so a bad quote is
    // rejected at ingestion rather than surfacing later as a mystery.
    linearQuoteInterpolation([quote], [], this.#maxGapMs);

    this.#quotes.push({ ...source });
    this.#lastAvailableMs = availableMs;
    this.#knowledgeMs =
      this.#knowledgeMs === null ? availableMs : Math.max(this.#knowledgeMs, availableMs);
  }

  observeMany(quotes: Iterable<unknown>): void {
    for (const quote of quotes) this.observe(quote);
  }

  /** Register a target. It stays pending until it can be answered honestly. */
  submit(target: unknown): void {
    partitionOf(target);
    const source = target as Record<string, unknown>;
    parseTimestampMs(source.target_time, "target_time");
    this.#targets.push({ ...source });
  }

  submitMany(targets: Iterable<unknown>): void {
    for (const target of targets) this.submit(target);
  }

  // --- resolution --------------------------------------------------------- //
  /**
   * Return every target that has become answerable, and drop it from pending.
   *
   * Evaluated at the engine's current knowledge time — the latest `available_time`
   * ingested — so a result can only appear once the data behind it genuinely had.
   */
  resolve(): Result[] {
    if (this.#knowledgeMs === null || this.#targets.length === 0) return [];

    const cutoff = this.knowledgeTime;
    const evaluated = linearQuoteInterpolation(
      this.#quotes,
      this.#targets.map((target) => ({ ...target, evaluation_time: cutoff })),
      this.#maxGapMs,
    );

    const settled: Result[] = [];
    const stillWaiting: Array<Record<string, unknown>> = [];
    evaluated.forEach((result, index) => {
      let waiting = WAITING.has(result.status);
      if (waiting && result.status === "unavailable" && this.#resolveUnavailable) {
        waiting = false;
      }
      if (waiting) stillWaiting.push(this.#targets[index]!);
      else settled.push(result);
    });

    this.#targets = stillWaiting;
    return settled;
  }

  // --- introspection ------------------------------------------------------ //
  /** The latest `available_time` ingested — this engine's "now". */
  get knowledgeTime(): string {
    if (this.#knowledgeMs === null) throw new Error("no quotes have been observed yet");
    return formatTimestampMs(this.#knowledgeMs);
  }

  /** Targets still waiting, each with the status explaining why. */
  get pending(): PendingEntry[] {
    if (this.#knowledgeMs === null) {
      return this.#targets.map((target) => ({ ...target, status: "no_quotes_yet" }));
    }
    const cutoff = this.knowledgeTime;
    const evaluated = linearQuoteInterpolation(
      this.#quotes,
      this.#targets.map((target) => ({ ...target, evaluation_time: cutoff })),
      this.#maxGapMs,
    );
    return this.#targets.map((target, index) => ({
      ...target,
      status: evaluated[index]!.status,
      wait_ms: evaluated[index]!.wait_ms,
    }));
  }

  get pendingCount(): number {
    return this.#targets.length;
  }

  /**
   * How many quotes are held. Interpolation needs both sides, so nothing is evicted
   * while any target could still bracket it.
   */
  get retained(): number {
    return this.#quotes.length;
  }
}
