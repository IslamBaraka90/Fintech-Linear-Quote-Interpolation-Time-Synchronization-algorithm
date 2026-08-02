"""Tests for the engine that waits.

The point being pinned: a target submitted before its right-hand endpoint exists must
NOT produce a number. It stays pending, and it resolves only once the data behind it
genuinely arrived.
"""

from __future__ import annotations

import pytest
from conftest import MAX_GAP_MS, interpolate, quotes, targets

from fintech_linear_quote import PendingInterpolator

TARGET = {
    "instrument": "A", "venue": "X", "session_id": "S",
    "target_time": "2026-01-01T00:00:01.000Z",
}


def engine(**kwargs) -> PendingInterpolator:
    return PendingInterpolator(MAX_GAP_MS, **kwargs)


# --- waiting is the whole point ------------------------------------------------- #
def test_a_target_does_not_resolve_before_its_right_endpoint():
    live = engine()
    live.observe(quotes(0)[0])
    live.submit(TARGET)
    assert live.resolve() == []
    assert live.pending_count == 1


def test_it_resolves_the_moment_the_endpoint_lands():
    live = engine()
    live.observe(quotes(0)[0])
    live.submit(TARGET)
    live.resolve()
    live.observe(quotes(1)[0])

    settled = live.resolve()
    assert len(settled) == 1
    assert settled[0]["status"] == "linear"
    assert settled[0]["bid"] == 100.0
    assert live.pending_count == 0


def test_a_resolved_target_is_not_returned_twice():
    live = engine()
    live.observe_many(quotes())
    live.submit(TARGET)
    assert len(live.resolve()) == 1
    assert live.resolve() == []


def test_the_result_matches_the_batch_function():
    """The live path and the research path must not be two different algorithms."""

    live = engine()
    live.observe_many(quotes())
    live.submit(TARGET)
    settled = live.resolve()[0]
    batch = interpolate(points=[{**TARGET, "evaluation_time": live.knowledge_time}])[0]
    assert settled == batch


def test_pending_says_why_it_is_waiting():
    live = engine()
    live.observe(quotes(0)[0])
    live.submit(TARGET)
    waiting = live.pending[0]
    assert waiting["status"] in ("unavailable", "right_not_available")


def test_pending_before_any_quote_is_explicit():
    live = engine()
    live.submit(TARGET)
    assert live.pending[0]["status"] == "no_quotes_yet"
    assert live.resolve() == []


# --- the knowledge clock ---------------------------------------------------------- #
def test_the_clock_is_the_latest_arrival():
    live = engine()
    live.observe_many(quotes())
    assert live.knowledge_time == "2026-01-01T00:00:02.120Z"


def test_the_clock_only_moves_on_ingestion():
    live = engine()
    live.observe(quotes(0)[0])
    before = live.knowledge_time
    live.submit(TARGET)
    live.resolve()
    assert live.knowledge_time == before


def test_reading_the_clock_before_any_quote_raises():
    with pytest.raises(ValueError, match="no quotes"):
        _ = engine().knowledge_time


def test_out_of_order_arrival_is_rejected():
    live = engine()
    live.observe(quotes(1)[0])
    with pytest.raises(ValueError, match="non-decreasing available_time"):
        live.observe(quotes(0)[0])


def test_simultaneous_arrivals_are_allowed():
    live = engine()
    rows = quotes(0) + [dict(quotes(0)[0], venue="Y")]
    live.observe_many(rows)
    assert live.retained == 2


# --- settled versus waiting -------------------------------------------------------- #
def test_an_exact_arrived_record_settles_immediately():
    live = engine()
    live.observe(quotes(0)[0])
    live.submit({**TARGET, "target_time": "2026-01-01T00:00:00.000Z"})
    settled = live.resolve()
    assert len(settled) == 1
    assert settled[0]["status"] == "exact"
    assert settled[0]["observable"] is True


def test_a_gap_that_is_too_wide_settles_rather_than_waits():
    """No amount of waiting will narrow the gap, so holding the target would lie."""

    live = PendingInterpolator(1)
    live.observe_many(quotes())
    live.submit(TARGET)
    settled = live.resolve()
    assert len(settled) == 1
    assert settled[0]["status"] == "gap_too_wide"


def test_an_unavailable_target_is_held_by_default():
    """Early in a session 'unavailable' usually means 'not yet', not 'never'."""

    live = engine()
    live.observe(quotes(0)[0])
    live.submit({**TARGET, "target_time": "2026-01-01T00:00:01.500Z"})
    assert live.resolve() == []


def test_unavailable_can_be_settled_on_request():
    live = engine(resolve_unavailable=True)
    live.observe(quotes(0)[0])
    live.submit({**TARGET, "target_time": "2026-01-01T00:00:01.500Z"})
    settled = live.resolve()
    assert len(settled) == 1
    assert settled[0]["status"] == "unavailable"


# --- bookkeeping -------------------------------------------------------------------- #
def test_many_targets_resolve_independently():
    live = engine()
    live.observe(quotes(0)[0])
    live.submit_many([TARGET, {**TARGET, "target_time": "2026-01-01T00:00:00.000Z"}])
    first = live.resolve()
    assert [row["status"] for row in first] == ["exact"]
    live.observe(quotes(1)[0])
    assert [row["status"] for row in live.resolve()] == ["linear"]


def test_retained_counts_the_quotes_held():
    live = engine()
    live.observe_many(quotes())
    assert live.retained == 2


def test_a_bad_quote_is_rejected_at_ingestion():
    live = engine()
    bad = quotes(0)[0]
    bad["bid"] = "100"
    with pytest.raises(ValueError, match="finite numbers"):
        live.observe(bad)
    assert live.retained == 0


def test_a_bad_target_is_rejected_at_submission():
    live = engine()
    with pytest.raises(ValueError):
        live.submit({**TARGET, "target_time": "not-a-time"})
    assert live.pending_count == 0


@pytest.mark.parametrize("bad", [0, -1, 1.5, "2000", None])
def test_a_bad_budget_raises(bad):
    with pytest.raises(ValueError, match="max_gap_ms"):
        PendingInterpolator(bad)
