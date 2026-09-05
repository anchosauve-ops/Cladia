"""Append-only, hash-chained JSONL ledger."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .model import DEFAULT_HALF_LIFE, Entry, EntryError, parse_ts

try:  # POSIX advisory locking; silently unavailable elsewhere
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore

LEDGER_DIRNAME = ".cladia"
LEDGER_FILENAME = "ledger.jsonl"
GENESIS = "0" * 64

_UNSET: Any = object()


class LedgerError(RuntimeError):
    pass


class Ledger:
    """A single JSONL file. Every line is an Entry whose hash covers the previous hash."""

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)

    # ---- location -------------------------------------------------------
    @classmethod
    def discover(cls, start: str | os.PathLike[str] | None = None, create: bool = False) -> "Ledger":
        """Find the ledger for the current context.

        Order: $CLADIA_LEDGER, then the nearest `.cladia/ledger.jsonl` walking up
        from `start`, then `~/.cladia/ledger.jsonl`.
        """
        env = os.environ.get("CLADIA_LEDGER")
        if env:
            return cls(env)
        here = Path(start or os.getcwd()).resolve()
        for d in [here, *here.parents]:
            p = d / LEDGER_DIRNAME / LEDGER_FILENAME
            if p.exists():
                return cls(p)
        home = Path(os.environ.get("CLADIA_HOME") or (Path.home() / LEDGER_DIRNAME)) / LEDGER_FILENAME
        led = cls(home)
        if create:
            led.ensure()
        return led

    @classmethod
    def init_here(cls, directory: str | os.PathLike[str]) -> "Ledger":
        led = cls(Path(directory) / LEDGER_DIRNAME / LEDGER_FILENAME)
        led.ensure()
        return led

    def ensure(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()

    def exists(self) -> bool:
        return self.path.exists()

    # ---- reading --------------------------------------------------------
    def entries(self) -> list[Entry]:
        if not self.path.exists():
            return []
        out: list[Entry] = []
        with self.path.open("r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(Entry.from_dict(json.loads(line)))
                except (json.JSONDecodeError, TypeError) as e:
                    raise LedgerError(f"{self.path}:{lineno}: unreadable entry: {e}") from e
        return out

    def get(self, entry_id: str) -> Entry | None:
        matches = [e for e in self.entries() if e.id == entry_id or e.id.startswith(entry_id)]
        if len(matches) > 1:
            exact = [e for e in matches if e.id == entry_id]
            if len(exact) == 1:
                return exact[0]
            raise LedgerError(f"ambiguous id prefix {entry_id!r}: {', '.join(e.id for e in matches)}")
        return matches[0] if matches else None

    def last_hash(self) -> str:
        last = GENESIS
        if self.path.exists():
            with self.path.open("rb") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if raw:
                        last = json.loads(raw).get("hash", last)
        return last

    # ---- writing --------------------------------------------------------
    def create(
        self,
        kind: str,
        text: str,
        *,
        tags: Iterable[str] = (),
        confidence: float = 0.8,
        half_life_days: float | None = _UNSET,
        evidence: Iterable[str] = (),
        session: str | None = None,
        author: str = "agent",
        supersedes: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> Entry:
        """Build, validate, seal and append an entry. Returns the sealed entry."""
        if half_life_days is _UNSET:
            half_life_days = DEFAULT_HALF_LIFE.get(kind)
        if supersedes:
            target = self.get(supersedes)
            if target is None:
                raise LedgerError(f"cannot supersede unknown entry {supersedes!r}")
            supersedes = target.id
        entry = Entry(
            kind=kind,
            text=text.strip(),
            tags=list(tags),
            confidence=float(confidence),
            half_life_days=half_life_days,
            evidence=[e for e in evidence if e],
            session=session or os.environ.get("CLADIA_SESSION"),
            author=author,
            supersedes=supersedes,
            meta=dict(meta or {}),
        )
        entry.validate()
        return self.append(entry)

    def append(self, entry: Entry) -> Entry:
        self.ensure()
        with self.path.open("a+", encoding="utf-8") as fh:
            if fcntl is not None:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                entry.seal(self.last_hash())
                fh.write(entry.to_json() + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            finally:
                if fcntl is not None:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        return entry

    # ---- integrity ------------------------------------------------------
    def verify(self) -> tuple[bool, list[str]]:
        """Walk the chain. Returns (ok, problems)."""
        problems: list[str] = []
        prev = GENESIS
        seen: set[str] = set()
        for i, e in enumerate(self.entries(), 1):
            if e.prev != prev:
                problems.append(f"#{i} {e.id}: prev hash mismatch (chain broken before this entry)")
            if e.compute_hash() != e.hash:
                problems.append(f"#{i} {e.id}: content hash mismatch (entry altered)")
            if e.id in seen:
                problems.append(f"#{i} {e.id}: duplicate id")
            seen.add(e.id)
            try:
                e.validate()
            except EntryError as err:
                problems.append(f"#{i} {e.id}: invalid: {err}")
            prev = e.hash
        return (not problems, problems)

    # ---- merging --------------------------------------------------------
    def merge_from(self, other: "Ledger", *, keep: str = "theirs", session: str | None = None) -> dict[str, Any]:
        """Rejoin two ledgers that diverged from a common prefix.

        One side is kept verbatim (its chain is untouched); the other side's entries
        after the fork are re-sealed onto its tip, keeping their ids, timestamps and
        content, and a `merge` entry records what happened. This is the one sanctioned
        rewrite of the file: content never changes, only `prev` and `hash` of the
        re-chained entries. Returns a summary dict; the file is rewritten atomically.
        """
        ours = self.entries()
        theirs = other.entries()
        merged, info = merge_entries(ours, theirs, keep=keep, session=session or os.environ.get("CLADIA_SESSION"))
        if info["changed"]:
            self._rewrite(merged)
        return info

    def _rewrite(self, entries: list[Entry]) -> None:
        self.ensure()
        tmp = self.path.with_suffix(self.path.suffix + f".{os.getpid()}.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for e in entries:
                fh.write(e.to_json() + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)

    # ---- views ----------------------------------------------------------
    def superseded_ids(self, entries: list[Entry] | None = None) -> set[str]:
        entries = self.entries() if entries is None else entries
        return {e.supersedes for e in entries if e.supersedes}

    def active(self, entries: list[Entry] | None = None) -> list[Entry]:
        """Entries that still carry weight: not superseded, not retracted, and not
        bookkeeping kinds (resolution, retraction)."""
        entries = self.entries() if entries is None else entries
        dead = self.superseded_ids(entries)
        return [e for e in entries if e.id not in dead and e.kind not in ("resolution", "retraction", "merge")]

    def resolutions(self, entries: list[Entry] | None = None) -> dict[str, Entry]:
        """Map prediction id -> latest resolution entry."""
        entries = self.entries() if entries is None else entries
        dead = self.superseded_ids(entries)
        out: dict[str, Entry] = {}
        for e in entries:
            if e.kind == "resolution" and e.id not in dead:
                out[e.meta["prediction"]] = e
        return out

    def lineage(self, entry_id: str, entries: list[Entry] | None = None) -> list[Entry]:
        """The chain of supersessions ending at entry_id, oldest first."""
        entries = self.entries() if entries is None else entries
        by_id = {e.id: e for e in entries}
        e = by_id.get(entry_id)
        chain: list[Entry] = []
        while e is not None:
            chain.append(e)
            e = by_id.get(e.supersedes) if e.supersedes else None
        return list(reversed(chain))

    def descendants(self, entry_id: str, entries: list[Entry] | None = None) -> list[Entry]:
        entries = self.entries() if entries is None else entries
        return [e for e in entries if e.supersedes == entry_id]

    # ---- predictions ----------------------------------------------------
    def open_predictions(self, now: datetime | None = None, entries: list[Entry] | None = None) -> list[Entry]:
        entries = self.entries() if entries is None else entries
        res = self.resolutions(entries)
        return [e for e in self.active(entries) if e.kind == "prediction" and e.id not in res]

    def overdue_predictions(self, now: datetime | None = None, entries: list[Entry] | None = None) -> list[Entry]:
        now = now or datetime.now(timezone.utc)
        return [e for e in self.open_predictions(now, entries) if parse_ts(e.meta["due"]) <= now]


def merge_entries(ours: list[Entry], theirs: list[Entry], *, keep: str = "theirs", session: str | None = None) -> tuple[list[Entry], dict[str, Any]]:
    """Pure merge of two entry lists. See Ledger.merge_from."""
    if keep not in ("theirs", "ours"):
        raise LedgerError("keep must be 'theirs' or 'ours'")
    n = 0
    while n < len(ours) and n < len(theirs) and ours[n].hash == theirs[n].hash:
        n += 1
    base, ours_tail, theirs_tail = ours[:n], ours[n:], theirs[n:]
    if n == 0 and ours and theirs:
        raise LedgerError("these ledgers share no history; refusing to merge unrelated chains")
    fork = base[-1].hash if base else GENESIS
    kept, moved, kept_name, moved_name = (theirs_tail, ours_tail, "theirs", "ours") if keep == "theirs" else (ours_tail, theirs_tail, "ours", "theirs")
    info: dict[str, Any] = {"fork": fork, "base": n, "kept": kept_name, "kept_entries": len(kept), "rechained": [e.id for e in moved], "changed": False, "fast_forward": False, "merge_id": None}
    if not moved:
        # nothing to re-chain: either identical, or a fast-forward to the kept side
        out = base + kept
        info["changed"] = len(out) != len(ours) or any(a.hash != b.hash for a, b in zip(out, ours))
        info["fast_forward"] = info["changed"]
        return out, info
    ids = {e.id for e in base + kept}
    dup = [e.id for e in moved if e.id in ids]
    if dup:
        raise LedgerError(f"cannot merge: ids present on both sides: {', '.join(dup)}")
    if not kept:
        # the other side has nothing new; keep our chain as is
        info["rechained"] = []
        return base + moved, info
    out = list(base) + list(kept)
    prev = out[-1].hash
    for e in moved:
        c = Entry.from_dict(e.body())
        c.seal(prev)
        out.append(c)
        prev = c.hash
    sessions = sorted({e.session for e in moved if e.session})
    who = f" from session {', '.join(sessions)}" if sessions else ""
    m = Entry(kind="merge", text=f"Merged {len(moved)} entr{'y' if len(moved) == 1 else 'ies'}{who} onto {out[n + len(kept) - 1].hash[:12]} (fork at {fork[:12]})",
              confidence=1.0, session=session, meta={"fork": fork, "onto": kept[-1].hash, "moved_from_tip": moved[-1].hash, "rechained": [e.id for e in moved]})
    m.validate()
    m.seal(prev)
    out.append(m)
    info.update(changed=True, merge_id=m.id)
    return out, info
