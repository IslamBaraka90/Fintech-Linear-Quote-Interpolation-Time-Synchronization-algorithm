/**
 * Bitemporal linear quote interpolation.
 *
 * Linear interpolation reaches *forward* in time: to value 10:00:01 it needs the quote
 * at 10:00:02. That makes it a research construct, never a live signal — and this
 * package is built so you cannot lose track of which one you are holding.
 *
 * ```ts
 * import { linearQuoteInterpolation } from "fintech-linear-quote";
 *
 * const results = linearQuoteInterpolation(quotes, targets, 2000);
 * ```
 *
 * Article: https://thefintechbuilder.com/market-data-engineering/time-synchronization/linear-quote-interpolation/
 */

export {
  type NormalisedQuote,
  type Quote,
  type Result,
  type Status,
  type Target,
  STATUSES,
  formatTimestampMs,
  linearQuoteInterpolation,
  parseTimestampMs,
} from "./core.ts";

export {
  type ErrorStats,
  type GapStats,
  type LookaheadRow,
  type StatusSummary,
  gapProfile,
  interpolationError,
  lookaheadCost,
  statusSummary,
} from "./leakage.ts";

export { type PendingEntry, PendingInterpolator } from "./pending.ts";
