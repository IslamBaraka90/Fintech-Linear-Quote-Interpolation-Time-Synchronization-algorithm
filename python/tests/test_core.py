"""Contract tests for the interpolator.

The fixture is the cross-language acceptance anchor: two quotes two seconds apart, and
five targets that between them hit `right_not_available`, `linear`,
`exact_not_available`, `exact` and `unavailable`. Its expected statuses are asserted
verbatim by this suite and by the TypeScript one.
"""

from __future__ import annotations

import pytest
from conftest import EXPECTED_STATUSES, MAX_GAP_MS, interpolate, quotes, targets

from fintech_linear_quote import linear_quote_interpolation, parse_timestamp_ms

# --- the shared fixture ------------------------------------------------------- #
def test_every_status_matches_the_fixture():
    assert [row["status"] for row in interpolate()] == EXPECTED_STATUSES


def test_one_result_per_target_in_order():
    results = interpolate()
    assert len(results) == len(targets())
    assert [row["target_time"] for row in results] == [
        target["target_time"] for target in targets()
    ]


def test_the_fixture_covers_five_distinct_statuses():
    assert len(set(EXPECTED_STATUSES)) == 5


def test_the_interpolated_midpoint_is_exact():
    """Target at 00:01 sits halfway between 00:00 (99/101) and 00:02 (101/103)."""

    row = interpolate()[1]
    assert row["status"] == "linear"
    assert row["weight"] == 0.5
    assert row["bid"] == 100.0
    assert row["ask"] == 102.0
    assert row["gap_ms"] == 2000


def test_an_empty_target_list_produces_nothing():
    assert interpolate(points=[]) == []


def test_no_quotes_means_every_target_is_unavailable():
    results = linear_quote_interpolation([], targets(), MAX_GAP_MS)
    assert {row["status"] for row in results} == {"unavailable"}
    assert {row["reason"] for row in results} == {"no_partition"}


# --- observed versus constructed ---------------------------------------------- #
def test_only_an_exact_arrived_record_is_observable():
    """The whole safety story in one assertion."""

    for row in interpolate():
        assert row["observable"] == (row["status"] == "exact")


def test_an_interpolated_row_is_never_observable():
    row = interpolate()[1]
    assert row["interpolated"] is True
    assert row["observable"] is False


def test_an_exact_hit_is_not_flagged_as_interpolated():
    row = interpolate()[3]
    assert row["status"] == "exact"
    assert row["interpolated"] is False
    assert row["weight"] == 0.0
    assert row["gap_ms"] == 0


def test_every_row_carries_first_knowable_at_when_endpoints_exist():
    for row in interpolate():
        if row["status"] in ("unavailable",):
            continue
        assert row["first_knowable_at"] is not None


def test_first_knowable_at_is_the_later_endpoint():
    row = interpolate()[1]
    assert row["first_knowable_at"] == "2026-01-01T00:00:02.120Z"


def test_first_knowable_at_is_compared_on_the_clock_not_as_strings():
    """'…00.500Z' sorts BEFORE '…00Z' lexicographically while being later in fact."""

    rows = [
        {"instrument": "A", "venue": "X", "session_id": "S",
         "event_time": "2026-01-01T00:00:00Z", "available_time": "2026-01-01T00:00:03Z",
         "bid": 1.0, "ask": 2.0},
        {"instrument": "A", "venue": "X", "session_id": "S",
         "event_time": "2026-01-01T00:00:02Z",
         "available_time": "2026-01-01T00:00:02.500Z", "bid": 3.0, "ask": 4.0},
    ]
    row = linear_quote_interpolation(
        rows,
        [{"instrument": "A", "venue": "X", "session_id": "S",
          "target_time": "2026-01-01T00:00:01Z",
          "evaluation_time": "2026-01-01T00:00:09Z"}],
        MAX_GAP_MS,
    )[0]
    # The later of 00:03 and 00:02.500 is 00:03 — a string max would have said 02.500.
    assert row["first_knowable_at"] == "2026-01-01T00:00:03.000Z"


# --- the knowledge cutoff ------------------------------------------------------ #
def test_a_right_endpoint_that_has_not_arrived_blocks_the_target():
    row = interpolate()[0]
    assert row["status"] == "right_not_available"
    assert row["bid"] is None
    assert row["wait_ms"] == 1120


def test_the_same_target_resolves_once_the_endpoint_lands():
    early, late = interpolate()[0], interpolate()[1]
    assert early["target_time"] == late["target_time"]
    assert early["status"] == "right_not_available"
    assert late["status"] == "linear"


def test_an_exact_record_that_has_not_arrived_is_not_used():
    row = interpolate()[2]
    assert row["status"] == "exact_not_available"
    assert row["bid"] is None
    assert row["wait_ms"] == 100


def test_wait_ms_says_how_much_longer_you_needed():
    row = interpolate()[2]
    assert row["first_knowable_at"] == "2026-01-01T00:00:00.100Z"
    assert row["wait_ms"] == 100


def test_a_settled_row_reports_zero_wait():
    for row in interpolate():
        if row["status"] in ("exact", "linear"):
            assert row["wait_ms"] == 0


# --- extrapolation is refused --------------------------------------------------- #
def test_a_target_before_the_first_quote_is_unavailable():
    row = interpolate()[4]
    assert row["status"] == "unavailable"
    assert row["reason"] == "extrapolation_disabled"


def test_a_target_after_the_last_quote_is_unavailable():
    row = interpolate(
        points=[{"instrument": "A", "venue": "X", "session_id": "S",
                 "target_time": "2026-01-01T00:00:05.000Z",
                 "evaluation_time": "2026-01-01T00:00:09.000Z"}]
    )[0]
    assert row["status"] == "unavailable"
    assert row["reason"] == "extrapolation_disabled"


def test_an_unknown_partition_is_unavailable():
    row = interpolate(
        points=[{"instrument": "ZZZ", "venue": "X", "session_id": "S",
                 "target_time": "2026-01-01T00:00:01.000Z",
                 "evaluation_time": "2026-01-01T00:00:09.000Z"}]
    )[0]
    assert row["status"] == "unavailable"
    assert row["reason"] == "no_partition"


# --- the gap budget -------------------------------------------------------------- #
def test_a_gap_wider_than_the_budget_is_refused():
    row = interpolate(max_gap_ms=1999)[1]
    assert row["status"] == "gap_too_wide"
    assert row["reason"] == "maximum_gap_exceeded"
    assert row["gap_ms"] == 2000


def test_the_budget_boundary_is_inclusive():
    assert interpolate(max_gap_ms=2000)[1]["status"] == "linear"


def test_the_gap_is_reported_even_when_refused():
    assert interpolate(max_gap_ms=1)[1]["gap_ms"] == 2000


def test_the_gap_budget_is_checked_before_availability():
    """A target that fails both should say the structural reason, not the timing one."""

    assert interpolate(max_gap_ms=1)[0]["status"] == "gap_too_wide"


@pytest.mark.parametrize("bad", [0, -1, 1.5, "2000", True, None])
def test_an_invalid_gap_budget_raises(bad):
    # Called directly rather than through the conftest helper, whose `None` means
    # "use the fixture default" and would swallow the case under test.
    with pytest.raises(ValueError, match="max_gap_ms"):
        linear_quote_interpolation(quotes(), targets(), bad)


# --- partitioning ---------------------------------------------------------------- #
def test_partitions_do_not_bleed_into_each_other():
    rows = quotes()
    for row in rows:
        row["venue"] = "Y"
    result = linear_quote_interpolation(rows, targets(1), MAX_GAP_MS)[0]
    assert result["status"] == "unavailable"
    assert result["reason"] == "no_partition"


def test_two_partitions_are_interpolated_independently():
    rows = quotes() + [dict(row, venue="Y", bid=row["bid"] + 10, ask=row["ask"] + 10)
                       for row in quotes()]
    points = targets(1) + [dict(targets(1)[0], venue="Y")]
    results = linear_quote_interpolation(rows, points, MAX_GAP_MS)
    assert results[0]["bid"] == 100.0
    assert results[1]["bid"] == 110.0


def test_a_duplicate_event_time_in_one_partition_raises():
    with pytest.raises(ValueError, match="duplicate event_time"):
        interpolate(rows=quotes(0, 0))


def test_the_same_event_time_in_two_partitions_is_fine():
    rows = quotes(0) + [dict(quotes(0)[0], venue="Y")]
    assert len(linear_quote_interpolation(rows, [], MAX_GAP_MS)) == 0


def test_quote_order_does_not_change_the_answer():
    forward = interpolate()
    backward = interpolate(rows=list(reversed(quotes())))
    assert forward == backward


# --- validation ------------------------------------------------------------------ #
@pytest.mark.parametrize("field", ["instrument", "venue", "session_id"])
@pytest.mark.parametrize("value", ["", "   ", 7, None])
def test_a_bad_partition_key_raises(field, value):
    rows = quotes(0)
    rows[0][field] = value
    with pytest.raises(ValueError, match="non-empty strings"):
        interpolate(rows=rows)


@pytest.mark.parametrize("value", ["100", None, True, float("nan"), float("inf")])
def test_a_non_numeric_price_raises(value):
    """`float('100')` would succeed in Python; TypeScript refuses it. So do we."""

    rows = quotes(0)
    rows[0]["bid"] = value
    with pytest.raises(ValueError, match="finite numbers"):
        interpolate(rows=rows)


def test_a_crossed_endpoint_raises():
    rows = quotes(0)
    rows[0]["bid"], rows[0]["ask"] = 101.0, 99.0
    with pytest.raises(ValueError, match="crossed endpoint"):
        interpolate(rows=rows)


def test_a_locked_endpoint_is_allowed():
    rows = quotes()
    rows[0]["bid"] = rows[0]["ask"]
    assert interpolate(rows=rows)[1]["status"] == "linear"


def test_available_before_event_raises():
    rows = quotes(0)
    rows[0]["available_time"] = "2025-12-31T00:00:00.000Z"
    with pytest.raises(ValueError, match="must not precede event_time"):
        interpolate(rows=rows)


def test_input_rows_are_never_mutated():
    rows, points = quotes(), targets()
    before = ([dict(r) for r in rows], [dict(t) for t in points])
    linear_quote_interpolation(rows, points, MAX_GAP_MS)
    assert (rows, points) == before


# --- timestamps are strict --------------------------------------------------------- #
def test_an_impossible_calendar_date_is_rejected():
    with pytest.raises(ValueError, match="not a real calendar time"):
        parse_timestamp_ms("2026-02-30T00:00:00.000Z")


@pytest.mark.parametrize(
    "timestamp",
    [
        "2026-01-01T00:00:00+00:00",
        "2026-01-01T00:00:00",
        "2026-01-01T00:00:00.0001Z",
        "2026-13-01T00:00:00Z",
        "",
        None,
        1767225600000,
    ],
)
def test_a_malformed_timestamp_is_rejected(timestamp):
    with pytest.raises(ValueError):
        parse_timestamp_ms(timestamp)


@pytest.mark.parametrize(
    "timestamp,expected",
    [
        ("1970-01-01T00:00:00Z", 0),
        ("1970-01-01T00:00:00.001Z", 1),
        ("2026-01-01T00:00:02.120Z", 1_767_225_602_120),
    ],
)
def test_a_valid_timestamp_parses_exactly(timestamp, expected):
    assert parse_timestamp_ms(timestamp) == expected


def test_a_second_precision_timestamp_is_accepted():
    rows = quotes()
    rows[0]["event_time"] = "2026-01-01T00:00:00Z"
    assert interpolate(rows=rows)[1]["status"] == "linear"
