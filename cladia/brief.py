"""Turn the ledger into a briefing a fresh session can absorb in one read."""
from __future__ import annotations

from datetime import datetime, timezone

from .calibration import calibration, verdict
from .ledger import Ledger
from .model import Entry, parse_ts
from .recall import recall


def _line(e: Entry, now: datetime, show_conf: bool = True) -> str:
    conf = f" ({e.effective_confidence(now):.0%})" if show_conf else ""
    who = " [human]" if e.author == "human" else ""
    tags = f"  #{' #'.join(e.tags)}" if e.tags else ""
    return f"- {e.text}{conf}{who}{tags}  `{e.id}`"


def brief(
    ledger: Ledger,
    topic: str = "",
    *,
    budget: int = 4000,
    now: datetime | None = None,
    limits: dict[str, int] | None = None,
) -> str:
    now = now or datetime.now(timezone.utc)
    limits = {"preference": 12, "mistake": 8, "fact": 12, "decision": 8, "prediction": 8, **(limits or {})}
    entries = ledger.entries()
    active = ledger.active(entries)
    ok, problems = ledger.verify()

    head = f"# Cladia briefing — {len(active)} active of {len(entries)} entries"
    if topic:
        head += f" — topic: {topic}"
    if not ok:
        head += f"\n\n**WARNING: ledger integrity check failed ({len(problems)} problems). Run `cladia verify`.**"
    sections: list[str] = [head]

    def pick(kind: str) -> list[Entry]:
        hits = recall(ledger, topic, kinds=[kind], limit=limits[kind], now=now, entries=entries)
        if not hits and topic:
            # Topic filter found nothing; for durable kinds fall back to the general set.
            if kind in ("preference", "mistake"):
                hits = recall(ledger, "", kinds=[kind], limit=limits[kind], now=now, entries=entries)
        return [e for _, e in hits]

    prefs = pick("preference")
    if prefs:
        sections.append("## How the humans here want things done\n" + "\n".join(_line(e, now, False) for e in prefs))

    mistakes = pick("mistake")
    if mistakes:
        lines = []
        for e in mistakes:
            lesson = e.meta.get("lesson")
            lines.append(_line(e, now, False) + (f"\n  → Lesson: {lesson}" if lesson else ""))
        sections.append("## Mistakes already made (do not repeat)\n" + "\n".join(lines))

    facts = pick("fact")
    if facts:
        sections.append("## What is believed to be true\n" + "\n".join(_line(e, now) for e in facts))

    decisions = pick("decision")
    if decisions:
        lines = []
        for e in decisions:
            why = e.meta.get("why")
            lines.append(_line(e, now, False) + (f"\n  → Why: {why}" if why else ""))
        sections.append("## Decisions already taken\n" + "\n".join(lines))

    open_preds = ledger.open_predictions(now, entries)
    if open_preds:
        open_preds.sort(key=lambda e: e.meta["due"])
        lines = []
        for e in open_preds[: limits["prediction"]]:
            due = parse_ts(e.meta["due"])
            flag = " **OVERDUE — resolve it**" if due <= now else ""
            lines.append(f"- p={e.confidence:.0%} by {due.date()}: {e.text}{flag}  `{e.id}`")
        sections.append("## Open predictions\n" + "\n".join(lines))

    stats = calibration(ledger, now, entries)
    sections.append("## Calibration\n" + verdict(stats))

    out = "\n\n".join(sections)
    if len(out) > budget:
        out = out[: budget - 40].rstrip() + "\n\n…(briefing truncated to budget)"
    return out
