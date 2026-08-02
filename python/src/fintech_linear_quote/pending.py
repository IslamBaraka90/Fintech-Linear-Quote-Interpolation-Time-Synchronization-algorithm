"""Interpolation that waits, because interpolation genuinely has to.

There is no streaming linear interpolation, and pretending otherwise is how lookahead
gets into a pipeline. To value 10:00:01 the algorithm needs the quote at 10:00:02, so
at 10:00:01 the answer does not exist yet. Any "live interpolator" that returns a
number at 10:00:01 is returning a number it could not have.

So this engine does the only honest thing: it **holds the target open**. You submit a
target, it stays pending, and it resolves the moment both bracketing endpoints have
arrived — no earlier. :attr:`PendingInterpolator.pending` is not a queue of failures;
it is an accurate statement of what is not yet knowable.

That makes the latency visible instead of hidden. ``resolve()`` returns each result
with the ``first_knowable_at`` that produced it, so the delay between asking and being
able to answer is a measured quantity rather than an assumption.

The engine's knowledge clock is the latest ``available_time`` it has ingested. Feeding
it a quote is the only thing that moves that clock forward, which is exactly how a
real consumer experiences time.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .core import (
    linear_quote_interpolation,
    parse_timestamp_ms,
    _partition,
)

__all__ = ["PendingInterpolator"]

#: Statuses that mean "come back later", as opposed to a settled answer.
_WAITING = frozenset(
    {"left_not_available", "right_not_available", "exact_not_available", "unavailable"}
)


class PendingInterpolator:
    """Submit targets, ingest quotes, collect results only once they are knowable.

    Args:
        max_gap_ms: Widest bracketing interval that may be interpolated across.
        resolve_unavailable: When ``True``, a target that currently reports
            ``unavailable`` (no bracketing pair yet) is settled immediately instead of
            being held. Defaults to ``False``, because early in a session
            ``unavailable`` usually means "the right-hand quote has not happened yet"
            rather than "it never will".
    """

    def __init__(self, max_gap_ms: int, resolve_unavailable: bool = False) -> None:
        if (
            isinstance(max_gap_ms, bool)
            or not isinstance(max_gap_ms, int)
            or max_gap_ms <= 0
        ):
            raise ValueError("max_gap_ms must be a positive integer")
        self._max_gap_ms = max_gap_ms
        self._resolve_unavailable = bool(resolve_unavailable)
        self._quotes: list[dict[str, Any]] = []
        self._targets: list[dict[str, Any]] = []
        self._knowledge_ms: int | None = None
        self._last_available_ms: int | None = None

    # --- ingestion ---------------------------------------------------------- #
    def observe(self, quote: Mapping[str, Any]) -> None:
        """Ingest one quote. Must not arrive before the previous one."""

        _partition(quote)
        available_ms = parse_timestamp_ms(quote.get("available_time"), "available_time")
        if self._last_available_ms is not None and available_ms < self._last_available_ms:
            raise ValueError("quotes must arrive in non-decreasing available_time order")

        # Validate the rest by running it through the normaliser, so a bad quote is
        # rejected at ingestion rather than surfacing later as a mystery.
        linear_quote_interpolation([quote], [], self._max_gap_ms)

        self._quotes.append(dict(quote))
        self._last_available_ms = available_ms
        self._knowledge_ms = (
            available_ms
            if self._knowledge_ms is None
            else max(self._knowledge_ms, available_ms)
        )

    def observe_many(self, quotes: Iterable[Mapping[str, Any]]) -> None:
        for quote in quotes:
            self.observe(quote)

    def submit(self, target: Mapping[str, Any]) -> None:
        """Register a target. It stays pending until it can be answered honestly."""

        _partition(target)
        parse_timestamp_ms(target.get("target_time"), "target_time")
        self._targets.append(dict(target))

    def submit_many(self, targets: Iterable[Mapping[str, Any]]) -> None:
        for target in targets:
            self.submit(target)

    # --- resolution --------------------------------------------------------- #
    def resolve(self) -> list[dict[str, Any]]:
        """Return every target that has become answerable, and drop it from pending.

        Evaluated at the engine's current knowledge time — the latest
        ``available_time`` ingested — so a result can only appear once the data behind
        it genuinely had.
        """

        if self._knowledge_ms is None or not self._targets:
            return []

        cutoff = self.knowledge_time
        evaluated = linear_quote_interpolation(
            self._quotes,
            [{**target, "evaluation_time": cutoff} for target in self._targets],
            self._max_gap_ms,
        )

        settled: list[dict[str, Any]] = []
        still_waiting: list[dict[str, Any]] = []
        for target, result in zip(self._targets, evaluated):
            waiting = result["status"] in _WAITING
            if waiting and result["status"] == "unavailable" and self._resolve_unavailable:
                waiting = False
            if waiting:
                still_waiting.append(target)
            else:
                settled.append(result)

        self._targets = still_waiting
        return settled

    # --- introspection ------------------------------------------------------ #
    @property
    def knowledge_time(self) -> str:
        """The latest ``available_time`` ingested — this engine's 'now'."""

        if self._knowledge_ms is None:
            raise ValueError("no quotes have been observed yet")
        from .core import format_timestamp_ms

        return format_timestamp_ms(self._knowledge_ms)

    @property
    def pending(self) -> list[dict[str, Any]]:
        """Targets still waiting, each with the status explaining why."""

        if self._knowledge_ms is None:
            return [{**target, "status": "no_quotes_yet"} for target in self._targets]

        cutoff = self.knowledge_time
        evaluated = linear_quote_interpolation(
            self._quotes,
            [{**target, "evaluation_time": cutoff} for target in self._targets],
            self._max_gap_ms,
        )
        return [
            {**target, "status": result["status"], "wait_ms": result["wait_ms"]}
            for target, result in zip(self._targets, evaluated)
        ]

    @property
    def pending_count(self) -> int:
        return len(self._targets)

    @property
    def retained(self) -> int:
        """How many quotes are held. Interpolation needs both sides, so nothing is
        evicted while any target could still bracket it."""

        return len(self._quotes)
