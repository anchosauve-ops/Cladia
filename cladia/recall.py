"""Relevance-ranked recall over active entries."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Iterable

from .ledger import Ledger
from .model import Entry

_WORD = re.compile(r"[a-z0-9][a-z0-9_\-./]*", re.I)
STOPWORDS = frozenset(
    "a an the of to in on for and or is are was were be been it its this that "
    "with as at by from we i you they he she not no do does did have has had".split()
)


def tokenize(text: str) -> list[str]:
    out = []
    for t in _WORD.findall(text or ""):
        t = t.lower().rstrip("._-/")
        if len(t) > 1 and t not in STOPWORDS:
            out.append(t)
    return out


def match_score(entry: Entry, qtokens: list[str]) -> float:
    if not qtokens:
        return 1.0
    ttoks = set(tokenize(entry.text))
    for key in ("lesson", "why"):
        if key in entry.meta:
            ttoks |= set(tokenize(str(entry.meta[key])))
    tagset = set(entry.tags)
    hits = 0.0
    for q in qtokens:
        if q in tagset:
            hits += 2.0
        elif q in ttoks:
            hits += 1.0
        elif any(t.startswith(q) or q.startswith(t) for t in ttoks | tagset if len(q) >= 4 and len(t) >= 4):
            hits += 0.5
    return min(1.0, hits / len(qtokens))


def recency_bonus(entry: Entry, now: datetime) -> float:
    """Gentle preference for newer entries; ranges (0, 0.15]."""
    age = entry.age_days(now)
    return 0.15 / (1.0 + age / 30.0)


def recall(
    ledger: Ledger,
    query: str = "",
    *,
    tags: Iterable[str] = (),
    kinds: Iterable[str] = (),
    limit: int = 10,
    now: datetime | None = None,
    min_confidence: float = 0.05,
    entries: list[Entry] | None = None,
) -> list[tuple[float, Entry]]:
    now = now or datetime.now(timezone.utc)
    qtokens = tokenize(query)
    want_tags = {t.strip().lower() for t in tags if t and t.strip()}
    want_kinds = {k.strip().lower() for k in kinds if k and k.strip()}
    scored: list[tuple[float, Entry]] = []
    for e in ledger.active(entries):
        if want_kinds and e.kind not in want_kinds:
            continue
        if want_tags and not want_tags.issubset(set(e.tags)):
            continue
        conf = e.effective_confidence(now)
        if conf < min_confidence:
            continue
        m = match_score(e, qtokens)
        if m <= 0:
            continue
        score = m * (0.3 + 0.7 * conf) + recency_bonus(e, now)
        scored.append((score, e))
    scored.sort(key=lambda p: (-p[0], p[1].ts), reverse=False)
    return scored[: max(0, limit)]
