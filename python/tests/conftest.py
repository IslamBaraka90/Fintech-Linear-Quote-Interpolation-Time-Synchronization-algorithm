"""Shared fixture access. The same JSON backs the TypeScript suite."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "fixtures.json").read_text(encoding="utf-8")
)
MAX_GAP_MS = FIXTURE["max_gap_ms"]
QUOTES = FIXTURE["quotes"]
TARGETS = FIXTURE["targets"]
EXPECTED_STATUSES = FIXTURE["expected_statuses"]


def quotes(*indexes: int) -> list[dict]:
    """Deep-copied fixture quotes — all, or the given 0-based positions."""

    if not indexes:
        return copy.deepcopy(QUOTES)
    return [copy.deepcopy(QUOTES[i]) for i in indexes]


def targets(*indexes: int) -> list[dict]:
    """Deep-copied fixture targets — all, or the given 0-based positions."""

    if not indexes:
        return copy.deepcopy(TARGETS)
    return [copy.deepcopy(TARGETS[i]) for i in indexes]


def interpolate(rows=None, points=None, max_gap_ms=None):
    from fintech_linear_quote import linear_quote_interpolation

    return linear_quote_interpolation(
        quotes() if rows is None else rows,
        targets() if points is None else points,
        MAX_GAP_MS if max_gap_ms is None else max_gap_ms,
    )
