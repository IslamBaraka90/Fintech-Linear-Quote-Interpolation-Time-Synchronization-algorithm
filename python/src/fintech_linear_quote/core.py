"""Bitemporal linear interpolation for validated top-of-book quotes.

This algorithm is the honest counterpart to previous-tick carry-forward, and the
difference between them is the whole point:

**Linear interpolation reaches forward in time.** To value 10:00:01 it needs the quote
at 10:00:02. That quote had not happened yet at 10:00:01 and could not have been known
at 10:00:01, which means an interpolated value is **never** an observed quote and must
never be fed to anything pretending to run live. It is a research construct — legal in
a covariance estimate, fraudulent in a signal.

This module therefore refuses to let you forget which one you are holding:

* Every result carries ``observable``. It is ``True`` only for an exactly-matching
  record that had already arrived. Every interpolated row is ``observable: False``
  and ``interpolated: True``.
* Every result carries ``first_knowable_at`` — the moment both endpoints had landed,
  which is the earliest a live system could have computed this number at all.
* Extrapolation is disabled. A target outside the observed range returns
  ``unavailable`` rather than a straight-line guess into a region with no right-hand
  anchor.

Two clocks, as everywhere in this family
----------------------------------------
``event_time`` orders market events; ``available_time`` says when this process could
know the record; a target's ``evaluation_time`` is the point-in-time cutoff. An
endpoint that exists but had not arrived yields ``left_not_available`` /
``right_not_available`` with a ``wait_ms`` telling you exactly how much longer you
would have had to wait. That is far more useful than a null, because it distinguishes
"the data is missing" from "you asked too early".

The gap budget
--------------
Interpolating across a two-second hole is arithmetic; interpolating across a
twenty-minute hole is invention. ``max_gap_ms`` draws that line and
``gap_too_wide`` reports crossing it, with the measured ``gap_ms`` attached so the
budget can be argued about with evidence.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Any, Iterable, Mapping

__all__ = [
    "linear_quote_interpolation",
    "parse_timestamp_ms",
    "format_timestamp_ms",
    "STATUSES",
]

#: RFC 3339 UTC, ``Z`` only, millisecond precision at most.
_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$"
)

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

#: Every status this module can return, for exhaustive handling by callers.
STATUSES = (
    "exact",
    "linear",
    "exact_not_available",
    "left_not_available",
    "right_not_available",
    "gap_too_wide",
    "unavailable",
)


def parse_timestamp_ms(value: Any, field: str = "timestamp") -> int:
    """Parse an RFC 3339 UTC timestamp to integer milliseconds since the epoch.

    Strict by design: ``2026-02-30`` is rejected rather than rolled over, which is
    what keeps this port and the TypeScript one agreeing on the same input.
    """

    if not isinstance(value, str):
        raise ValueError(f"{field} must be an RFC 3339 UTC timestamp ending in Z")
    match = _TIMESTAMP.match(value)
    if match is None:
        raise ValueError(
            f"{field} must be an RFC 3339 UTC timestamp ending in Z "
            f"(millisecond precision at most), got: {value!r}"
        )

    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    fraction = match.group(7) or ""
    millisecond = int(fraction.ljust(3, "0")) if fraction else 0

    try:
        moment = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError(f"{field} is not a real calendar time: {value!r}") from exc

    delta: timedelta = moment - _EPOCH
    return delta.days * 86_400_000 + delta.seconds * 1000 + millisecond


def format_timestamp_ms(milliseconds: int) -> str:
    """Render integer milliseconds back to the RFC 3339 form this package accepts."""

    moment = _EPOCH + timedelta(milliseconds=milliseconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _partition(record: Mapping[str, Any]) -> tuple[str, str, str]:
    if not isinstance(record, Mapping):
        raise ValueError("each quote and target must be a mapping")
    values = tuple(record.get(name) for name in ("instrument", "venue", "session_id"))
    if not all(isinstance(value, str) and value.strip() for value in values):
        raise ValueError("instrument, venue, and session_id must be non-empty strings")
    return values  # type: ignore[return-value]


def _price(record: Mapping[str, Any], field: str) -> float:
    """Strictly a number, never a coerced string.

    ``float("100.5")`` would succeed here while the TypeScript port rejects anything
    that is not a number, so accepting strings would make the two implementations
    disagree on the same input.
    """

    value = record.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        raise ValueError("bid and ask must be finite numbers")
    return float(value)


def _empty(
    target: Mapping[str, Any], status: str, reason: str, **diagnostics: Any
) -> dict[str, Any]:
    return {
        "instrument": target["instrument"],
        "venue": target["venue"],
        "session_id": target["session_id"],
        "target_time": target["target_time"],
        "evaluation_time": target["evaluation_time"],
        "bid": None,
        "ask": None,
        "status": status,
        "reason": reason,
        "interpolated": False,
        "observable": False,
        "left_event_time": diagnostics.get("left_event_time"),
        "right_event_time": diagnostics.get("right_event_time"),
        "left_available_time": diagnostics.get("left_available_time"),
        "right_available_time": diagnostics.get("right_available_time"),
        "first_knowable_at": diagnostics.get("first_knowable_at"),
        "weight": None,
        "gap_ms": diagnostics.get("gap_ms"),
        "wait_ms": diagnostics.get("wait_ms", 0),
    }


def _normalise_quotes(
    quotes: Iterable[Mapping[str, Any]],
) -> dict[tuple[str, str, str], list[dict[str, Any]]]:
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    seen: set[tuple[str, str, str, int]] = set()

    for quote in quotes:
        key = _partition(quote)
        event_ms = parse_timestamp_ms(quote.get("event_time"), "event_time")
        available_ms = parse_timestamp_ms(quote.get("available_time"), "available_time")
        if available_ms < event_ms:
            raise ValueError(
                "available_time must not precede event_time on the normalized clock"
            )
        bid = _price(quote, "bid")
        ask = _price(quote, "ask")
        if bid > ask:
            # A crossed endpoint would produce an interpolated quote that is crossed
            # for part of the interval and not for the rest, which is not a quote.
            raise ValueError("crossed endpoint quote: bid must not exceed ask")

        identity = (*key, event_ms)
        if identity in seen:
            raise ValueError(
                "duplicate event_time within an instrument/venue/session partition"
            )
        seen.add(identity)
        grouped.setdefault(key, []).append(
            {
                "event_time": quote["event_time"],
                "available_time": quote["available_time"],
                "bid": bid,
                "ask": ask,
                "event_ms": event_ms,
                "available_ms": available_ms,
            }
        )

    for rows in grouped.values():
        rows.sort(key=lambda row: row["event_ms"])
    return grouped


def _bracket(rows: list[dict[str, Any]], target_ms: int) -> tuple[int, bool]:
    """Locate the insertion point for ``target_ms`` and whether it lands exactly.

    A plain binary search over the sorted event times. Returns the index of the first
    row at or after the target, plus whether that row *is* the target.
    """

    low, high = 0, len(rows)
    while low < high:
        middle = (low + high) // 2
        if rows[middle]["event_ms"] < target_ms:
            low = middle + 1
        else:
            high = middle
    exact = low < len(rows) and rows[low]["event_ms"] == target_ms
    return low, exact


def linear_quote_interpolation(
    quotes: Iterable[Mapping[str, Any]],
    targets: Iterable[Mapping[str, Any]],
    max_gap_ms: int,
) -> list[dict[str, Any]]:
    """Evaluate quote interpolation targets under an explicit knowledge cutoff.

    Args:
        quotes: Top-of-book records carrying ``instrument``, ``venue``,
            ``session_id``, ``event_time``, ``available_time``, ``bid`` and ``ask``.
        targets: Points to value, each with ``target_time`` and ``evaluation_time``.
        max_gap_ms: Widest bracketing interval that may be interpolated across.

    Returns:
        One result per target, in the order given. Never raises for a target that
        cannot be valued — that is reported as a status, because a batch of research
        targets should not be aborted by one unreachable point.
    """

    if isinstance(max_gap_ms, bool) or not isinstance(max_gap_ms, int) or max_gap_ms <= 0:
        raise ValueError("max_gap_ms must be a positive integer")

    grouped = _normalise_quotes(quotes)

    results: list[dict[str, Any]] = []
    for target in targets:
        key = _partition(target)
        target_ms = parse_timestamp_ms(target.get("target_time"), "target_time")
        evaluation_ms = parse_timestamp_ms(
            target.get("evaluation_time"), "evaluation_time"
        )
        rows = grouped.get(key)
        if not rows:
            results.append(_empty(target, "unavailable", "no_partition"))
            continue

        index, exact = _bracket(rows, target_ms)

        if exact:
            quote = rows[index]
            wait_ms = max(0, quote["available_ms"] - evaluation_ms)
            shared = {
                "left_event_time": quote["event_time"],
                "right_event_time": quote["event_time"],
                "left_available_time": quote["available_time"],
                "right_available_time": quote["available_time"],
                "first_knowable_at": quote["available_time"],
                "gap_ms": 0,
            }
            if wait_ms:
                results.append(
                    _empty(
                        target,
                        "exact_not_available",
                        "exact_record_arrives_after_evaluation",
                        wait_ms=wait_ms,
                        **shared,
                    )
                )
                continue
            results.append(
                {
                    **_empty(target, "exact", "observed_quote", **shared),
                    "bid": quote["bid"],
                    "ask": quote["ask"],
                    # The ONLY status that is a real observation rather than a
                    # construct. Everything else below is arithmetic.
                    "observable": True,
                    "weight": 0.0,
                }
            )
            continue

        if index == 0 or index == len(rows):
            # No right-hand anchor (or no left one). Extrapolation is refused rather
            # than guessed: a straight line out of the observed range is a claim
            # about a region where nothing was measured.
            results.append(_empty(target, "unavailable", "extrapolation_disabled"))
            continue

        left, right = rows[index - 1], rows[index]
        gap_ms = right["event_ms"] - left["event_ms"]
        diagnostics = {
            "left_event_time": left["event_time"],
            "right_event_time": right["event_time"],
            "left_available_time": left["available_time"],
            "right_available_time": right["available_time"],
            # Compared on the parsed clock, NOT as strings: "…00.500Z" sorts before
            # "…00Z" lexicographically while being half a second later in fact.
            "first_knowable_at": format_timestamp_ms(
                max(left["available_ms"], right["available_ms"])
            ),
            "gap_ms": gap_ms,
        }

        if gap_ms > max_gap_ms:
            results.append(
                _empty(target, "gap_too_wide", "maximum_gap_exceeded", **diagnostics)
            )
            continue
        if left["available_ms"] > evaluation_ms:
            results.append(
                _empty(
                    target,
                    "left_not_available",
                    "left_endpoint_arrives_after_evaluation",
                    wait_ms=left["available_ms"] - evaluation_ms,
                    **diagnostics,
                )
            )
            continue
        if right["available_ms"] > evaluation_ms:
            results.append(
                _empty(
                    target,
                    "right_not_available",
                    "right_endpoint_arrives_after_evaluation",
                    wait_ms=right["available_ms"] - evaluation_ms,
                    **diagnostics,
                )
            )
            continue

        weight = (target_ms - left["event_ms"]) / gap_ms
        results.append(
            {
                **_empty(target, "linear", "both_endpoints_available", **diagnostics),
                "bid": left["bid"] + weight * (right["bid"] - left["bid"]),
                "ask": left["ask"] + weight * (right["ask"] - left["ask"]),
                "interpolated": True,
                "observable": False,
                "weight": weight,
            }
        )
    return results
