"""How wrong is the straight line, and how much did the two clocks cost?

The core module tells you *what* the interpolated value is. This module tells you
whether you should have used it — which is a different question and the one that gets
skipped.

**How wrong is the line?** — :func:`interpolation_error`
Leave-one-out validation on your own data. For every interior quote, hide it,
interpolate its event time from its two neighbours, and compare against what was
actually there. The result is an empirical error distribution for exactly the
instrument, venue and session you are about to interpolate. This is the honest answer
to "is linear good enough here", and it costs one pass over data you already have.

**What did point-in-time honesty cost?** — :func:`lookahead_cost`
Evaluates every target twice: once respecting ``evaluation_time``, and once the way a
revised historical file lets you cheat, with every record treated as instantly
available. The difference is the set of values a naive pipeline would have produced
and a live system never could.

**Where should the gap budget sit?** — :func:`gap_profile`
The observed distribution of inter-quote gaps per partition, with percentiles. A
``max_gap_ms`` below the median means most targets return ``gap_too_wide``; one above
the 99th percentile means the budget is not doing anything. Both are worth knowing
before the number is hard-coded.

:func:`status_summary` is the small roll-up: how many targets landed in each status,
and what share were genuinely observable rather than constructed.
"""

from __future__ import annotations

from statistics import mean, median
from typing import Any, Iterable, Mapping

from .core import (
    STATUSES,
    _normalise_quotes,
    _partition,
    linear_quote_interpolation,
)

__all__ = [
    "interpolation_error",
    "lookahead_cost",
    "gap_profile",
    "status_summary",
]


def _percentile(values: list[float], fraction: float) -> float:
    """Nearest-rank percentile. Deliberately simple, and identical in both ports."""

    if not values:
        raise ValueError("percentile of an empty sequence")
    ordered = sorted(values)
    rank = max(1, min(len(ordered), int(round(fraction * len(ordered) + 0.5)) - 0))
    index = min(len(ordered) - 1, max(0, rank - 1))
    return ordered[index]


def interpolation_error(
    quotes: Iterable[Mapping[str, Any]], max_gap_ms: int
) -> dict[str, Any]:
    """Leave-one-out validation of the straight line against the data itself.

    For every interior quote, interpolate its own event time from its two neighbours
    and compare with the observed value. Brackets wider than ``max_gap_ms`` are
    skipped, because those are the ones the core module would refuse anyway.

    Returns:
        Per-partition and overall statistics: the number of points checked, mean and
        max absolute error for bid and ask, and the max error expressed as a fraction
        of the observed spread — which is the form that tells you whether the error
        matters. An error of half a tick is noise; an error of two spreads means the
        line is inventing a price level that never traded.
    """

    if isinstance(max_gap_ms, bool) or not isinstance(max_gap_ms, int) or max_gap_ms <= 0:
        raise ValueError("max_gap_ms must be a positive integer")

    grouped = _normalise_quotes(quotes)
    per_partition: dict[str, Any] = {}
    all_points: list[dict[str, float]] = []
    total_skipped = 0

    for key in sorted(grouped):
        rows = grouped[key]
        points: list[dict[str, float]] = []
        skipped = 0
        for index in range(1, len(rows) - 1):
            left, actual, right = rows[index - 1], rows[index], rows[index + 1]
            gap_ms = right["event_ms"] - left["event_ms"]
            if gap_ms > max_gap_ms or gap_ms == 0:
                skipped += 1
                continue
            weight = (actual["event_ms"] - left["event_ms"]) / gap_ms
            predicted_bid = left["bid"] + weight * (right["bid"] - left["bid"])
            predicted_ask = left["ask"] + weight * (right["ask"] - left["ask"])
            spread = actual["ask"] - actual["bid"]
            points.append(
                {
                    "event_time": actual["event_time"],
                    "bid_error": predicted_bid - actual["bid"],
                    "ask_error": predicted_ask - actual["ask"],
                    "spread": spread,
                    "gap_ms": gap_ms,
                }
            )
        per_partition["|".join(key)] = _error_stats(points, skipped)
        all_points.extend(points)
        total_skipped += skipped

    return {
        "partitions": per_partition,
        # The roll-up must carry the skips too: "checked 0, skipped 0" would read as
        # "there was nothing to check" when in fact every bracket was refused.
        "overall": _error_stats(all_points, total_skipped),
    }


def _error_stats(points: list[dict[str, Any]], skipped: int) -> dict[str, Any]:
    if not points:
        return {
            "checked": 0,
            "skipped": skipped,
            "mean_abs_bid_error": None,
            "mean_abs_ask_error": None,
            "max_abs_bid_error": None,
            "max_abs_ask_error": None,
            "max_error_in_spreads": None,
        }

    bid_errors = [abs(point["bid_error"]) for point in points]
    ask_errors = [abs(point["ask_error"]) for point in points]
    # Expressed in spreads because an absolute price error means nothing on its own:
    # 0.01 is enormous on a 0.005-wide book and invisible on a 5.00-wide one.
    in_spreads = [
        max(abs(point["bid_error"]), abs(point["ask_error"])) / point["spread"]
        for point in points
        if point["spread"] > 0
    ]

    return {
        "checked": len(points),
        "skipped": skipped,
        "mean_abs_bid_error": mean(bid_errors),
        "mean_abs_ask_error": mean(ask_errors),
        "max_abs_bid_error": max(bid_errors),
        "max_abs_ask_error": max(ask_errors),
        "max_error_in_spreads": max(in_spreads) if in_spreads else None,
    }


def lookahead_cost(
    quotes: Iterable[Mapping[str, Any]],
    targets: Iterable[Mapping[str, Any]],
    max_gap_ms: int,
) -> dict[str, Any]:
    """Compare point-in-time evaluation against the revised-file view.

    The naive view sets every ``evaluation_time`` far into the future, so every record
    looks instantly available — which is exactly what reading a corrected historical
    file gives you. Any target that becomes valuable only under that view is a target
    a live system could never have produced.

    Returns:
        A summary plus the individual ``rows`` that changed, each naming the honest
        status, the naive status, and the ``wait_ms`` the honest evaluation was short
        by. That wait is the actionable number: it says how much later the decision
        would have had to be taken for the value to be real.
    """

    quote_list = [dict(quote) for quote in quotes]
    target_list = [dict(target) for target in targets]

    honest = linear_quote_interpolation(quote_list, target_list, max_gap_ms)
    # A cutoff after every available_time in the batch: the revised-file view.
    naive_targets = [
        {**target, "evaluation_time": "9999-12-31T23:59:59.999Z"}
        for target in target_list
    ]
    naive = linear_quote_interpolation(quote_list, naive_targets, max_gap_ms)

    rows: list[dict[str, Any]] = []
    for honest_row, naive_row in zip(honest, naive):
        if honest_row["status"] == naive_row["status"]:
            continue
        rows.append(
            {
                "instrument": honest_row["instrument"],
                "venue": honest_row["venue"],
                "session_id": honest_row["session_id"],
                "target_time": honest_row["target_time"],
                "evaluation_time": honest_row["evaluation_time"],
                "point_in_time_status": honest_row["status"],
                "revised_status": naive_row["status"],
                "point_in_time_bid": honest_row["bid"],
                "revised_bid": naive_row["bid"],
                "point_in_time_ask": honest_row["ask"],
                "revised_ask": naive_row["ask"],
                "wait_ms": honest_row["wait_ms"],
                "first_knowable_at": naive_row["first_knowable_at"],
            }
        )

    total = len(honest)
    waits = [row["wait_ms"] for row in rows if row["wait_ms"]]
    return {
        "summary": {
            "total_targets": total,
            "differing": len(rows),
            "differing_share": (len(rows) / total) if total else 0.0,
            "max_wait_ms": max(waits) if waits else None,
            "median_wait_ms": median(waits) if waits else None,
        },
        "rows": rows,
    }


def gap_profile(quotes: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Distribution of inter-quote gaps per partition, for choosing ``max_gap_ms``.

    A budget below the median makes most targets ``gap_too_wide``; a budget above the
    maximum is not constraining anything. The useful settings live between the two,
    and this is how you find out where.
    """

    grouped = _normalise_quotes(quotes)
    partitions: dict[str, Any] = {}
    all_gaps: list[float] = []

    for key in sorted(grouped):
        rows = grouped[key]
        gaps = [
            float(rows[index]["event_ms"] - rows[index - 1]["event_ms"])
            for index in range(1, len(rows))
        ]
        partitions["|".join(key)] = _gap_stats(gaps, len(rows))
        all_gaps.extend(gaps)

    return {
        "partitions": partitions,
        "overall": _gap_stats(all_gaps, sum(len(rows) for rows in grouped.values())),
    }


def _gap_stats(gaps: list[float], quote_count: int) -> dict[str, Any]:
    if not gaps:
        return {
            "quotes": quote_count,
            "gaps": 0,
            "min_ms": None,
            "median_ms": None,
            "p95_ms": None,
            "max_ms": None,
        }
    return {
        "quotes": quote_count,
        "gaps": len(gaps),
        "min_ms": min(gaps),
        "median_ms": median(gaps),
        "p95_ms": _percentile(gaps, 0.95),
        "max_ms": max(gaps),
    }


def status_summary(results: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Roll up a batch of results by status, separating observed from constructed."""

    rows = list(results)
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping) or "status" not in row:
            raise ValueError(
                f"results[{index}] must come from linear_quote_interpolation()"
            )

    counts = {status: 0 for status in STATUSES}
    for row in rows:
        status = str(row["status"])
        counts[status] = counts.get(status, 0) + 1

    observable = sum(1 for row in rows if row.get("observable"))
    interpolated = sum(1 for row in rows if row.get("interpolated"))

    return {
        "total": len(rows),
        "counts": counts,
        # The distinction that matters: how much of this batch is measurement and how
        # much is arithmetic. A research set that is 95% interpolated is a model
        # output, whatever the column headers say.
        "observable": observable,
        "interpolated": interpolated,
        "observable_share": (observable / len(rows)) if rows else 0.0,
        "unresolved": len(rows) - observable - interpolated,
    }
