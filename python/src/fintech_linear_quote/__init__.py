"""Bitemporal linear quote interpolation.

Linear interpolation reaches *forward* in time: to value 10:00:01 it needs the quote
at 10:00:02. That makes it a research construct, never a live signal — and this
package is built so you cannot lose track of which one you are holding.

Quickstart::

    from fintech_linear_quote import linear_quote_interpolation

    results = linear_quote_interpolation(quotes, targets, max_gap_ms=2000)

See :mod:`fintech_linear_quote.core` for the interpolation rule,
:mod:`fintech_linear_quote.pending` for the engine that waits until a value is
knowable, and :mod:`fintech_linear_quote.leakage` for error and lookahead measurement.

Article: https://thefintechbuilder.com/market-data-engineering/time-synchronization/linear-quote-interpolation/
"""

from .core import (
    STATUSES,
    format_timestamp_ms,
    linear_quote_interpolation,
    parse_timestamp_ms,
)
from .leakage import (
    gap_profile,
    interpolation_error,
    lookahead_cost,
    status_summary,
)
from .pending import PendingInterpolator

__version__ = "0.1.0"

__all__ = [
    "PendingInterpolator",
    "STATUSES",
    "__version__",
    "format_timestamp_ms",
    "gap_profile",
    "interpolation_error",
    "linear_quote_interpolation",
    "lookahead_cost",
    "parse_timestamp_ms",
    "status_summary",
]
