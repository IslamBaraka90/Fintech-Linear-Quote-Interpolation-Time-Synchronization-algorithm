"""Tests for leave-one-out error, lookahead cost, gap profiling and the roll-up."""

from __future__ import annotations

import pytest
from conftest import MAX_GAP_MS, interpolate, quotes, targets

from fintech_linear_quote import (
    gap_profile,
    interpolation_error,
    linear_quote_interpolation,
    lookahead_cost,
    status_summary,
)


def series(values, start_ms=0, step_ms=1000, spread=2.0):
    """A single-partition quote series with a given bid path."""

    return [
        {
            "instrument": "A", "venue": "X", "session_id": "S",
            "event_time": f"2026-01-01T00:00:{(start_ms + index * step_ms) // 1000:02d}."
                          f"{(start_ms + index * step_ms) % 1000:03d}Z",
            "available_time": f"2026-01-01T00:00:{(start_ms + index * step_ms) // 1000:02d}."
                              f"{(start_ms + index * step_ms) % 1000:03d}Z",
            "bid": float(value),
            "ask": float(value) + spread,
        }
        for index, value in enumerate(values)
    ]


# --- interpolation_error ------------------------------------------------------- #
def test_a_perfectly_linear_series_has_zero_error():
    """The straight line is exactly right when the data is a straight line."""

    stats = interpolation_error(series([10, 11, 12, 13, 14]), 5000)["overall"]
    assert stats["checked"] == 3
    assert stats["max_abs_bid_error"] == pytest.approx(0.0)
    assert stats["mean_abs_ask_error"] == pytest.approx(0.0)


def test_a_kinked_series_has_measurable_error():
    """A V shape is where linear interpolation lies the most."""

    stats = interpolation_error(series([10, 20, 10]), 5000)["overall"]
    assert stats["checked"] == 1
    # The midpoint of 10 and 10 is 10; the observed value was 20.
    assert stats["max_abs_bid_error"] == pytest.approx(10.0)


def test_the_error_is_also_expressed_in_spreads():
    """An absolute price error means nothing without the spread to scale it."""

    stats = interpolation_error(series([10, 20, 10], spread=2.0), 5000)["overall"]
    assert stats["max_error_in_spreads"] == pytest.approx(5.0)


def test_a_wide_bracket_is_skipped_not_counted():
    stats = interpolation_error(series([10, 20, 10]), 1)["overall"]
    assert stats["checked"] == 0
    assert stats["max_abs_bid_error"] is None


def test_the_roll_up_carries_the_skip_count():
    """'checked 0, skipped 0' would read as 'nothing to check' rather than
    'every bracket was refused' — two very different statements."""

    result = interpolation_error(series([10, 20, 10, 30]), 1)
    assert result["overall"]["checked"] == 0
    assert result["overall"]["skipped"] == 2
    assert result["overall"]["skipped"] == sum(
        stats["skipped"] for stats in result["partitions"].values()
    )


def test_endpoints_are_never_checked():
    """Leave-one-out needs a neighbour on each side."""

    assert interpolation_error(series([10, 11]), 5000)["overall"]["checked"] == 0


def test_a_single_quote_yields_nothing_to_check():
    assert interpolation_error(series([10]), 5000)["overall"]["checked"] == 0


def test_partitions_are_reported_separately():
    rows = series([10, 11, 12]) + [
        dict(row, venue="Y") for row in series([10, 20, 10])
    ]
    result = interpolation_error(rows, 5000)
    assert result["partitions"]["A|X|S"]["max_abs_bid_error"] == pytest.approx(0.0)
    assert result["partitions"]["A|Y|S"]["max_abs_bid_error"] == pytest.approx(10.0)


def test_the_overall_roll_up_covers_every_partition():
    rows = series([10, 11, 12]) + [dict(row, venue="Y") for row in series([10, 20, 10])]
    result = interpolation_error(rows, 5000)
    assert result["overall"]["checked"] == 2


@pytest.mark.parametrize("bad", [0, -1, 1.5, "5000"])
def test_a_bad_budget_raises(bad):
    with pytest.raises(ValueError, match="max_gap_ms"):
        interpolation_error(series([10, 11, 12]), bad)


# --- lookahead_cost ------------------------------------------------------------- #
def test_the_lookahead_finds_the_targets_that_needed_the_future():
    result = lookahead_cost(quotes(), targets(), MAX_GAP_MS)
    assert result["summary"]["differing"] > 0


def test_a_blocked_target_becomes_valuable_under_the_revised_view():
    result = lookahead_cost(quotes(), targets(0), MAX_GAP_MS)
    row = result["rows"][0]
    assert row["point_in_time_status"] == "right_not_available"
    assert row["revised_status"] == "linear"
    assert row["point_in_time_bid"] is None
    assert row["revised_bid"] == 100.0


def test_the_wait_is_the_actionable_number():
    result = lookahead_cost(quotes(), targets(0), MAX_GAP_MS)
    assert result["rows"][0]["wait_ms"] == 1120
    assert result["summary"]["max_wait_ms"] == 1120


def test_a_target_evaluated_late_enough_costs_nothing():
    result = lookahead_cost(quotes(), targets(1), MAX_GAP_MS)
    assert result["rows"] == []
    assert result["summary"]["differing"] == 0
    assert result["summary"]["max_wait_ms"] is None


def test_the_share_is_over_every_target():
    result = lookahead_cost(quotes(), targets(), MAX_GAP_MS)
    assert result["summary"]["total_targets"] == len(targets())
    assert result["summary"]["differing_share"] == pytest.approx(
        result["summary"]["differing"] / len(targets())
    )


def test_a_structurally_impossible_target_is_not_lookahead():
    """Extrapolation stays unavailable in both views, so it must not be counted."""

    result = lookahead_cost(quotes(), targets(4), MAX_GAP_MS)
    assert result["rows"] == []


def test_the_revised_view_reports_when_the_value_became_knowable():
    result = lookahead_cost(quotes(), targets(0), MAX_GAP_MS)
    assert result["rows"][0]["first_knowable_at"] == "2026-01-01T00:00:02.120Z"


# --- gap_profile ----------------------------------------------------------------- #
def test_the_gap_profile_measures_the_spacing():
    profile = gap_profile(series([1, 2, 3, 4, 5]))["overall"]
    assert profile["quotes"] == 5
    assert profile["gaps"] == 4
    assert profile["min_ms"] == 1000
    assert profile["max_ms"] == 1000
    assert profile["median_ms"] == 1000


def test_an_uneven_series_shows_its_worst_gap():
    rows = series([1, 2, 3])
    rows[2]["event_time"] = "2026-01-01T00:00:09.000Z"
    rows[2]["available_time"] = "2026-01-01T00:00:09.000Z"
    # Events now sit at 00.000, 01.000, 09.000 — gaps of 1000ms and 8000ms.
    profile = gap_profile(rows)["overall"]
    assert profile["min_ms"] == 1000
    assert profile["max_ms"] == 8000


def test_a_single_quote_has_no_gaps():
    profile = gap_profile(series([1]))["overall"]
    assert profile["gaps"] == 0
    assert profile["median_ms"] is None


def test_the_profile_separates_partitions():
    rows = series([1, 2, 3]) + [dict(row, venue="Y") for row in series([1, 2])]
    profile = gap_profile(rows)
    assert profile["partitions"]["A|X|S"]["gaps"] == 2
    assert profile["partitions"]["A|Y|S"]["gaps"] == 1


def test_the_profile_bounds_a_sensible_budget():
    """The whole point: a budget below the median refuses most brackets."""

    rows = series([1, 2, 3, 4])
    profile = gap_profile(rows)["overall"]
    below = interpolation_error(rows, int(profile["median_ms"]) - 1)["overall"]
    above = interpolation_error(rows, int(profile["max_ms"]) * 3)["overall"]
    assert below["checked"] == 0
    assert above["checked"] == 2


# --- status_summary --------------------------------------------------------------- #
def test_the_summary_counts_every_status():
    summary = status_summary(interpolate())
    assert summary["total"] == 5
    assert summary["counts"]["linear"] == 1
    assert summary["counts"]["exact"] == 1
    assert summary["counts"]["unavailable"] == 1


def test_observed_and_constructed_are_separated():
    summary = status_summary(interpolate())
    assert summary["observable"] == 1
    assert summary["interpolated"] == 1
    assert summary["unresolved"] == 3


def test_the_observable_share_is_over_the_whole_batch():
    assert status_summary(interpolate())["observable_share"] == pytest.approx(1 / 5)


def test_an_empty_batch_summarises_to_zero():
    summary = status_summary([])
    assert summary["total"] == 0
    assert summary["observable_share"] == 0.0


def test_every_known_status_appears_in_the_counts():
    counts = status_summary(interpolate())["counts"]
    assert set(counts) >= {"exact", "linear", "gap_too_wide", "unavailable"}


def test_the_summary_rejects_foreign_rows():
    with pytest.raises(ValueError, match="linear_quote_interpolation"):
        status_summary([{"nope": 1}])


def test_the_summary_agrees_with_a_direct_count():
    results = linear_quote_interpolation(quotes(), targets(), MAX_GAP_MS)
    summary = status_summary(results)
    assert summary["counts"]["linear"] == sum(
        1 for row in results if row["status"] == "linear"
    )
