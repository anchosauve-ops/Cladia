"""Score resolved predictions so the agent can learn how much to trust itself."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .ledger import Ledger
from .model import Entry, parse_ts

BUCKETS = [(0.0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)]


def calibration(ledger: Ledger, now: datetime | None = None, entries: list[Entry] | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    entries = ledger.entries() if entries is None else entries
    res = ledger.resolutions(entries)
    dead = ledger.superseded_ids(entries)
    preds = [e for e in entries if e.kind == "prediction" and e.id not in dead]

    pairs: list[tuple[float, int, Entry]] = []
    for p in preds:
        r = res.get(p.id)
        if r is not None:
            pairs.append((float(p.confidence), 1 if r.meta["outcome"] else 0, p))

    n = len(pairs)
    brier = sum((p - o) ** 2 for p, o, _ in pairs) / n if n else None
    base_rate = sum(o for _, o, _ in pairs) / n if n else None
    # Brier skill score vs. always predicting the base rate.
    if n and base_rate is not None and 0 < base_rate < 1:
        ref = sum((base_rate - o) ** 2 for _, o, _ in pairs) / n
        skill = 1 - brier / ref if ref else None
    else:
        skill = None
    mean_p = sum(p for p, _, _ in pairs) / n if n else None
    overconfidence = (mean_p - base_rate) if n else None

    buckets = []
    for lo, hi in BUCKETS:
        inb = [(p, o) for p, o, _ in pairs if lo <= p < hi]
        buckets.append(
            {
                "range": [lo, min(hi, 1.0)],
                "n": len(inb),
                "mean_confidence": (sum(p for p, _ in inb) / len(inb)) if inb else None,
                "observed": (sum(o for _, o in inb) / len(inb)) if inb else None,
            }
        )

    open_preds = [p for p in preds if p.id not in res]
    overdue = [p for p in open_preds if parse_ts(p.meta["due"]) <= now]
    return {
        "resolved": n,
        "open": len(open_preds),
        "overdue": len(overdue),
        "brier": brier,
        "skill": skill,
        "base_rate": base_rate,
        "mean_confidence": mean_p,
        "overconfidence": overconfidence,
        "buckets": buckets,
        "overdue_ids": [p.id for p in overdue],
    }


def verdict(stats: dict[str, Any]) -> str:
    """One plain sentence a future session can act on."""
    n = stats["resolved"]
    if n == 0:
        return "No resolved predictions yet, so calibration is unknown. Make predictions and resolve them."
    oc = stats["overconfidence"] or 0.0
    brier = stats["brier"]
    if n < 10:
        size = f"only {n} resolved prediction{'s' if n != 1 else ''}, so treat this as weak evidence"
    else:
        size = f"{n} resolved predictions"
    if abs(oc) < 0.05:
        tilt = "well calibrated"
    elif oc > 0:
        tilt = f"overconfident by about {oc:.0%}"
    else:
        tilt = f"underconfident by about {-oc:.0%}"
    return f"Across {size}: {tilt} (Brier {brier:.3f}; 0 is perfect, 0.25 is coin-flip)."
