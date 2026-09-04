"""Entry model for the Cladia ledger.

An Entry is one immutable record in an append-only, hash-chained log.
Nothing is ever edited or deleted; later entries *supersede* earlier ones.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from typing import Any

KINDS = (
    "fact",        # something believed about the world, the codebase, or the task
    "preference",  # how a human wants things done
    "decision",    # a choice that was made, with rationale and alternatives
    "mistake",     # something that went wrong, and the lesson drawn from it
    "prediction",  # a falsifiable claim with a probability and a due date
    "resolution",  # the outcome of a prediction
    "retraction",  # withdraws an earlier entry
)

# Default half-lives in days. None means the entry does not decay.
DEFAULT_HALF_LIFE: dict[str, float | None] = {
    "fact": 120.0,
    "preference": None,
    "decision": None,
    "mistake": None,
    "prediction": None,
    "resolution": None,
    "retraction": None,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_ts(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class EntryError(ValueError):
    pass


@dataclass
class Entry:
    kind: str
    text: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    ts: str = field(default_factory=now_iso)
    tags: list[str] = field(default_factory=list)
    confidence: float = 0.8
    half_life_days: float | None = None
    evidence: list[str] = field(default_factory=list)
    session: str | None = None
    author: str = "agent"
    supersedes: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    prev: str = ""
    hash: str = ""

    # ---- lifecycle -----------------------------------------------------
    def __post_init__(self) -> None:
        self.tags = sorted({t.strip().lower() for t in self.tags if t and t.strip()})

    def validate(self) -> None:
        if self.kind not in KINDS:
            raise EntryError(f"unknown kind {self.kind!r}; expected one of {', '.join(KINDS)}")
        if not self.text or not self.text.strip():
            raise EntryError("text must not be empty")
        if not (0.0 <= float(self.confidence) <= 1.0):
            raise EntryError("confidence must be between 0 and 1")
        if self.half_life_days is not None and self.half_life_days <= 0:
            raise EntryError("half_life_days must be positive")
        if self.author not in ("agent", "human"):
            raise EntryError("author must be 'agent' or 'human'")
        if self.kind == "prediction":
            due = self.meta.get("due")
            if not due:
                raise EntryError("a prediction needs meta.due (ISO date)")
            try:
                parse_ts(due)
            except ValueError as e:
                raise EntryError(f"bad due date {due!r}: {e}") from e
        if self.kind == "resolution":
            if not self.meta.get("prediction"):
                raise EntryError("a resolution needs meta.prediction (the prediction id)")
            if self.meta.get("outcome") not in (True, False):
                raise EntryError("a resolution needs meta.outcome true/false")
        if self.kind == "retraction" and not self.supersedes:
            raise EntryError("a retraction must supersede an entry")

    # ---- hashing -------------------------------------------------------
    def body(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("hash")
        return d

    def compute_hash(self) -> str:
        payload = self.prev + "\n" + canonical(self.body())
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def seal(self, prev: str) -> "Entry":
        self.prev = prev
        self.hash = self.compute_hash()
        return self

    # ---- serialisation ------------------------------------------------
    def to_json(self) -> str:
        return canonical(asdict(self))

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Entry":
        known = {f.name for f in fields(cls)}
        clean = {k: v for k, v in d.items() if k in known}
        clean.setdefault("meta", {})
        return cls(**clean)

    # ---- derived -------------------------------------------------------
    def age_days(self, at: datetime | None = None) -> float:
        at = at or datetime.now(timezone.utc)
        return max(0.0, (at - parse_ts(self.ts)).total_seconds() / 86400.0)

    def effective_confidence(self, at: datetime | None = None) -> float:
        c = float(self.confidence)
        if self.half_life_days:
            c *= 0.5 ** (self.age_days(at) / float(self.half_life_days))
        return c

    def short(self) -> str:
        return f"[{self.id}] {self.kind:<10} {self.text}"
