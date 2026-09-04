"""Command-line interface. `python -m cladia --help` or `cladia --help`."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from . import __version__
from .brief import brief
from .calibration import calibration, verdict
from .ledger import Ledger, LedgerError
from .model import KINDS, Entry, EntryError, parse_ts
from .recall import recall


def _ledger(args: argparse.Namespace) -> Ledger:
    if args.ledger:
        return Ledger(args.ledger)
    return Ledger.discover(create=True)


def _emit(args: argparse.Namespace, obj, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(obj, ensure_ascii=False, indent=2, default=lambda o: o.__dict__))
    else:
        print(text)


def _tags(s: str | None) -> list[str]:
    return [t for t in (s or "").split(",") if t.strip()]


def _entry_text(e: Entry, now: datetime) -> str:
    parts = [f"{e.id}  {e.ts}  {e.kind:<10} conf={e.confidence:.2f}→{e.effective_confidence(now):.2f}  by {e.author}"]
    if e.tags:
        parts.append(f"  tags: {', '.join(e.tags)}")
    parts.append(f"  {e.text}")
    for k in ("why", "lesson", "due", "outcome", "note", "reason"):
        if k in e.meta:
            parts.append(f"  {k}: {e.meta[k]}")
    if e.meta.get("alternatives"):
        parts.append(f"  alternatives: {'; '.join(e.meta['alternatives'])}")
    if e.evidence:
        parts.append(f"  evidence: {', '.join(e.evidence)}")
    if e.supersedes:
        parts.append(f"  supersedes: {e.supersedes}")
    if e.session:
        parts.append(f"  session: {e.session}")
    return "\n".join(parts)


# ---- commands -------------------------------------------------------------

def cmd_init(args):
    led = Ledger.init_here(args.directory)
    _emit(args, {"ledger": str(led.path)}, f"initialised {led.path}")


def cmd_where(args):
    led = _ledger(args)
    _emit(args, {"ledger": str(led.path), "exists": led.exists()}, str(led.path))


def _common_create(args, kind, meta=None, confidence=None, author=None):
    led = _ledger(args)
    kwargs = dict(
        tags=_tags(args.tags),
        confidence=confidence if confidence is not None else args.confidence,
        evidence=args.evidence or [],
        session=args.session,
        author=author or args.author,
        meta=meta or {},
    )
    if getattr(args, "half_life", None) is not None:
        kwargs["half_life_days"] = None if args.half_life == 0 else args.half_life
    if getattr(args, "supersedes", None):
        kwargs["supersedes"] = args.supersedes
    e = led.create(kind, args.text, **kwargs)
    _emit(args, e.__dict__, f"{e.kind} {e.id} recorded")


def cmd_remember(args):
    _common_create(args, args.kind)


def cmd_decide(args):
    meta = {}
    if args.why:
        meta["why"] = args.why
    if args.alternatives:
        meta["alternatives"] = args.alternatives
    _common_create(args, "decision", meta=meta, confidence=args.confidence)


def cmd_mistake(args):
    _common_create(args, "mistake", meta={"lesson": args.lesson}, confidence=1.0)


def cmd_predict(args):
    try:
        due = parse_ts(args.due if "T" in args.due else args.due + "T00:00:00+00:00")
    except ValueError as e:
        raise SystemExit(f"bad --due: {e}")
    _common_create(args, "prediction", meta={"due": due.isoformat()}, confidence=args.p)


def cmd_resolve(args):
    led = _ledger(args)
    target = led.get(args.prediction)
    if target is None or target.kind != "prediction":
        raise SystemExit(f"no prediction with id {args.prediction!r}")
    if target.id in led.resolutions():
        raise SystemExit(f"prediction {target.id} is already resolved; use `correct` on the resolution to change it")
    outcome = args.outcome.lower() in ("true", "yes", "y", "1", "t")
    meta = {"prediction": target.id, "outcome": outcome}
    if args.note:
        meta["note"] = args.note
    e = led.create("resolution", f"{'CONFIRMED' if outcome else 'REFUTED'}: {target.text}", meta=meta,
                   confidence=1.0, author=args.author, session=args.session, tags=target.tags)
    _emit(args, e.__dict__, f"resolution {e.id} recorded — prediction was {'right' if outcome == (target.confidence >= 0.5) else 'wrong'} (p={target.confidence:.0%}, outcome={outcome})")


def cmd_correct(args):
    led = _ledger(args)
    target = led.get(args.id)
    if target is None:
        raise SystemExit(f"no entry with id {args.id!r}")
    meta = dict(target.meta)
    if args.why:
        meta["why"] = args.why
    e = led.create(
        target.kind, args.text,
        tags=_tags(args.tags) or target.tags,
        confidence=args.confidence if args.confidence is not None else target.confidence,
        half_life_days=target.half_life_days,
        evidence=args.evidence or target.evidence,
        session=args.session, author=args.author, supersedes=target.id, meta=meta,
    )
    _emit(args, e.__dict__, f"{e.kind} {e.id} supersedes {target.id}")


def cmd_retract(args):
    led = _ledger(args)
    target = led.get(args.id)
    if target is None:
        raise SystemExit(f"no entry with id {args.id!r}")
    e = led.create("retraction", args.reason or f"retracted {target.kind} {target.id}", supersedes=target.id,
                   confidence=1.0, author=args.author, session=args.session, tags=target.tags,
                   meta={"reason": args.reason} if args.reason else {})
    _emit(args, e.__dict__, f"retraction {e.id} withdraws {target.id}")


def cmd_recall(args):
    led = _ledger(args)
    now = datetime.now(timezone.utc)
    hits = recall(led, args.query or "", tags=_tags(args.tags), kinds=_tags(args.kind), limit=args.limit, now=now)
    if args.json:
        _emit(args, [{"score": round(s, 4), **e.__dict__} for s, e in hits], "")
        return
    if not hits:
        print("nothing recalled")
        return
    for s, e in hits:
        print(f"{s:.2f}  {e.short()}")
        for k in ("lesson", "why"):
            if k in e.meta:
                print(f"       {k}: {e.meta[k]}")


def cmd_brief(args):
    led = _ledger(args)
    print(brief(led, args.topic or "", budget=args.budget))


def cmd_calibration(args):
    led = _ledger(args)
    stats = calibration(led)
    if args.json:
        _emit(args, stats, "")
        return
    print(verdict(stats))
    print(f"resolved={stats['resolved']} open={stats['open']} overdue={stats['overdue']}")
    if stats["resolved"]:
        skill = "n/a" if stats["skill"] is None else f"{stats['skill']:.2f}"
        print(f"brier={stats['brier']:.3f}  skill={skill}  "
              f"mean_confidence={stats['mean_confidence']:.2f}  base_rate={stats['base_rate']:.2f}")
        print("bucket        n   said   observed")
        for b in stats["buckets"]:
            lo, hi = b["range"]
            said = "  -  " if b["mean_confidence"] is None else f"{b['mean_confidence']:.2f} "
            obs = "  -  " if b["observed"] is None else f"{b['observed']:.2f} "
            print(f"{lo:.1f}–{hi:.1f}   {b['n']:4d}   {said}  {obs}")
    if stats["overdue_ids"]:
        print("overdue: " + ", ".join(stats["overdue_ids"]))


def cmd_verify(args):
    led = _ledger(args)
    ok, problems = led.verify()
    n = len(led.entries())
    if args.json:
        _emit(args, {"ok": ok, "entries": n, "problems": problems}, "")
    else:
        print(f"{'OK' if ok else 'BROKEN'}: {n} entries, {len(problems)} problems")
        for p in problems:
            print("  " + p)
    if not ok:
        raise SystemExit(2)


def cmd_log(args):
    led = _ledger(args)
    now = datetime.now(timezone.utc)
    entries = led.entries()
    if not args.all:
        entries = led.active(entries)
    if args.kind:
        entries = [e for e in entries if e.kind in _tags(args.kind)]
    entries = entries[-args.limit:] if args.limit else entries
    if args.json:
        _emit(args, [e.__dict__ for e in entries], "")
        return
    for e in entries:
        print(f"{e.ts[:10]}  {e.effective_confidence(now):.2f}  {e.short()}")


def cmd_show(args):
    led = _ledger(args)
    e = led.get(args.id)
    if e is None:
        raise SystemExit(f"no entry with id {args.id!r}")
    now = datetime.now(timezone.utc)
    if args.json:
        _emit(args, {"entry": e.__dict__, "lineage": [x.__dict__ for x in led.lineage(e.id)],
                     "descendants": [x.__dict__ for x in led.descendants(e.id)]}, "")
        return
    print(_entry_text(e, now))
    lin = led.lineage(e.id)
    if len(lin) > 1:
        print("  lineage: " + " → ".join(x.id for x in lin))
    desc = led.descendants(e.id)
    if desc:
        print("  superseded by: " + ", ".join(f"{x.id} ({x.kind})" for x in desc))


def cmd_mcp(args):
    from .mcp import serve
    serve(_ledger(args))


# ---- parser ---------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="cladia", description="A lineage of memory for agents.")
    p.add_argument("--version", action="version", version=f"cladia {__version__}")
    p.add_argument("--ledger", help="path to ledger.jsonl (default: $CLADIA_LEDGER, nearest .cladia/, or ~/.cladia/)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    sub = p.add_subparsers(dest="cmd", required=True)

    def writer(sp):
        sp.add_argument("--tags", help="comma-separated tags")
        sp.add_argument("--evidence", nargs="*", help="paths, URLs, commit shas")
        sp.add_argument("--session", default=None, help="session identifier (default: $CLADIA_SESSION)")
        sp.add_argument("--author", default="agent", choices=["agent", "human"])
        sp.set_defaults(confidence=0.8)

    s = sub.add_parser("init", help="create .cladia/ledger.jsonl in a directory"); s.add_argument("directory", nargs="?", default=os.getcwd()); s.set_defaults(fn=cmd_init)
    s = sub.add_parser("where", help="print which ledger would be used"); s.set_defaults(fn=cmd_where)

    s = sub.add_parser("remember", help="record a fact or preference")
    s.add_argument("text"); s.add_argument("--kind", default="fact", choices=["fact", "preference"])
    s.add_argument("--confidence", type=float, default=0.8)
    s.add_argument("--half-life", type=float, default=None, help="days until confidence halves (0 = never decays)")
    s.add_argument("--supersedes", help="id of an entry this replaces")
    writer(s); s.set_defaults(fn=cmd_remember)

    s = sub.add_parser("decide", help="record a decision with its rationale")
    s.add_argument("text"); s.add_argument("--why"); s.add_argument("--alternatives", nargs="*")
    s.add_argument("--confidence", type=float, default=0.8); s.add_argument("--supersedes")
    writer(s); s.set_defaults(fn=cmd_decide)

    s = sub.add_parser("mistake", help="record something that went wrong and the lesson")
    s.add_argument("text"); s.add_argument("--lesson", required=True)
    writer(s); s.set_defaults(fn=cmd_mistake)

    s = sub.add_parser("predict", help="record a falsifiable prediction")
    s.add_argument("text"); s.add_argument("--p", type=float, required=True, help="probability 0..1")
    s.add_argument("--due", required=True, help="ISO date by which it can be judged")
    writer(s); s.set_defaults(fn=cmd_predict)

    s = sub.add_parser("resolve", help="record how a prediction turned out")
    s.add_argument("prediction"); s.add_argument("--outcome", required=True, help="true/false")
    s.add_argument("--note"); s.add_argument("--session"); s.add_argument("--author", default="agent", choices=["agent", "human"])
    s.set_defaults(fn=cmd_resolve)

    s = sub.add_parser("correct", help="supersede an entry with a corrected one (history is kept)")
    s.add_argument("id"); s.add_argument("text"); s.add_argument("--why")
    s.add_argument("--confidence", type=float, default=None)
    writer(s); s.set_defaults(fn=cmd_correct, author="human")
    s.set_defaults(author="human")

    s = sub.add_parser("retract", help="withdraw an entry")
    s.add_argument("id"); s.add_argument("--reason"); s.add_argument("--session")
    s.add_argument("--author", default="agent", choices=["agent", "human"]); s.set_defaults(fn=cmd_retract)

    s = sub.add_parser("recall", help="search active entries")
    s.add_argument("query", nargs="?"); s.add_argument("--tags"); s.add_argument("--kind", help="comma-separated kinds")
    s.add_argument("--limit", type=int, default=10); s.set_defaults(fn=cmd_recall)

    s = sub.add_parser("brief", help="print the briefing for a new session")
    s.add_argument("--topic", default=""); s.add_argument("--budget", type=int, default=4000); s.set_defaults(fn=cmd_brief)

    s = sub.add_parser("calibration", help="how well past confidence matched reality"); s.set_defaults(fn=cmd_calibration)
    s = sub.add_parser("verify", help="check the hash chain"); s.set_defaults(fn=cmd_verify)

    s = sub.add_parser("log", help="list entries"); s.add_argument("--limit", type=int, default=50)
    s.add_argument("--all", action="store_true", help="include superseded and bookkeeping entries")
    s.add_argument("--kind"); s.set_defaults(fn=cmd_log)

    s = sub.add_parser("show", help="show one entry with its lineage"); s.add_argument("id"); s.set_defaults(fn=cmd_show)
    s = sub.add_parser("mcp", help="serve the ledger over MCP (stdio)"); s.set_defaults(fn=cmd_mcp)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.fn(args)
    except (LedgerError, EntryError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
