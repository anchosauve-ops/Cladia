"""A minimal Model Context Protocol server over stdio, no SDK required.

Speaks JSON-RPC 2.0, one message per line. Enough of the protocol for
Claude Code, Claude Desktop, and other MCP clients to list and call tools.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any, Callable

from . import __version__
from .brief import brief
from .calibration import calibration, verdict
from .ledger import Ledger, LedgerError
from .model import EntryError, parse_ts
from .recall import recall

PROTOCOL_VERSION = "2025-06-18"


def _tools(led: Ledger) -> dict[str, tuple[dict[str, Any], Callable[[dict[str, Any]], str]]]:
    def t_brief(a):
        return brief(led, a.get("topic", ""), budget=int(a.get("budget", 4000)))

    def t_recall(a):
        hits = recall(led, a.get("query", ""), tags=a.get("tags", []), kinds=a.get("kinds", []), limit=int(a.get("limit", 10)))
        if not hits:
            return "nothing recalled"
        now = datetime.now(timezone.utc)
        out = []
        for s, e in hits:
            extra = "".join(f"\n    {k}: {e.meta[k]}" for k in ("lesson", "why") if k in e.meta)
            out.append(f"{s:.2f} [{e.id}] {e.kind} ({e.effective_confidence(now):.0%}{', human' if e.author=='human' else ''}) {e.text}{extra}")
        return "\n".join(out)

    def t_remember(a):
        e = led.create(a.get("kind", "fact"), a["text"], tags=a.get("tags", []), confidence=float(a.get("confidence", 0.8)),
                       evidence=a.get("evidence", []), author=a.get("author", "agent"), supersedes=a.get("supersedes"))
        return f"recorded {e.kind} {e.id}"

    def t_decide(a):
        meta = {k: a[k] for k in ("why", "alternatives") if a.get(k)}
        e = led.create("decision", a["text"], tags=a.get("tags", []), confidence=float(a.get("confidence", 0.8)),
                       evidence=a.get("evidence", []), meta=meta, supersedes=a.get("supersedes"))
        return f"recorded decision {e.id}"

    def t_mistake(a):
        e = led.create("mistake", a["text"], tags=a.get("tags", []), confidence=1.0, evidence=a.get("evidence", []),
                       meta={"lesson": a["lesson"]})
        return f"recorded mistake {e.id}"

    def t_predict(a):
        due = a["due"] if "T" in a["due"] else a["due"] + "T00:00:00+00:00"
        e = led.create("prediction", a["text"], tags=a.get("tags", []), confidence=float(a["p"]), meta={"due": parse_ts(due).isoformat()})
        return f"recorded prediction {e.id} (p={e.confidence:.0%}, due {due[:10]})"

    def t_resolve(a):
        target = led.get(a["prediction"])
        if target is None or target.kind != "prediction":
            raise LedgerError(f"no prediction {a['prediction']!r}")
        if target.id in led.resolutions():
            raise LedgerError(f"prediction {target.id} already resolved")
        meta = {"prediction": target.id, "outcome": bool(a["outcome"])}
        if a.get("note"):
            meta["note"] = a["note"]
        e = led.create("resolution", f"{'CONFIRMED' if meta['outcome'] else 'REFUTED'}: {target.text}", meta=meta,
                       confidence=1.0, tags=target.tags, author=a.get("author", "agent"))
        return f"recorded resolution {e.id}; " + verdict(calibration(led))

    def t_correct(a):
        target = led.get(a["id"])
        if target is None:
            raise LedgerError(f"no entry {a['id']!r}")
        meta = dict(target.meta)
        if a.get("why"):
            meta["why"] = a["why"]
        e = led.create(target.kind, a["text"], tags=a.get("tags") or target.tags,
                       confidence=float(a.get("confidence", target.confidence)), half_life_days=target.half_life_days,
                       evidence=target.evidence, author=a.get("author", "human"), supersedes=target.id, meta=meta)
        return f"{e.kind} {e.id} supersedes {target.id}"

    def t_retract(a):
        target = led.get(a["id"])
        if target is None:
            raise LedgerError(f"no entry {a['id']!r}")
        e = led.create("retraction", a.get("reason") or f"retracted {target.kind} {target.id}", supersedes=target.id,
                       confidence=1.0, tags=target.tags, meta={"reason": a["reason"]} if a.get("reason") else {})
        return f"retraction {e.id} withdraws {target.id}"

    def t_calibration(a):
        return json.dumps({"verdict": verdict(calibration(led)), **calibration(led)}, indent=2)

    def t_verify(a):
        ok, problems = led.verify()
        return "OK: chain intact" if ok else "BROKEN:\n" + "\n".join(problems)

    S = lambda d, **k: {"type": "string", "description": d, **k}  # noqa: E731
    tags = {"type": "array", "items": {"type": "string"}, "description": "tags for later recall"}
    conf = {"type": "number", "minimum": 0, "maximum": 1, "description": "confidence 0..1"}
    return {
        "cladia_brief": ({"type": "object", "properties": {"topic": S("optional topic to focus the briefing"), "budget": {"type": "integer"}}},
                         t_brief),
        "cladia_recall": ({"type": "object", "properties": {"query": S("free text"), "tags": tags,
                                                            "kinds": {"type": "array", "items": {"type": "string"}}, "limit": {"type": "integer"}}},
                          t_recall),
        "cladia_remember": ({"type": "object", "required": ["text"],
                             "properties": {"text": S("the fact or preference"), "kind": S("fact or preference", enum=["fact", "preference"]),
                                            "tags": tags, "confidence": conf, "evidence": {"type": "array", "items": {"type": "string"}},
                                            "author": S("agent or human", enum=["agent", "human"]), "supersedes": S("id this replaces")}},
                            t_remember),
        "cladia_decide": ({"type": "object", "required": ["text"],
                           "properties": {"text": S("the decision"), "why": S("rationale"), "alternatives": {"type": "array", "items": {"type": "string"}},
                                          "tags": tags, "confidence": conf, "evidence": {"type": "array", "items": {"type": "string"}}, "supersedes": S("id this replaces")}},
                          t_decide),
        "cladia_mistake": ({"type": "object", "required": ["text", "lesson"],
                            "properties": {"text": S("what went wrong"), "lesson": S("what to do differently"), "tags": tags,
                                           "evidence": {"type": "array", "items": {"type": "string"}}}},
                           t_mistake),
        "cladia_predict": ({"type": "object", "required": ["text", "p", "due"],
                            "properties": {"text": S("a falsifiable claim"), "p": conf, "due": S("ISO date by which it can be judged"), "tags": tags}},
                           t_predict),
        "cladia_resolve": ({"type": "object", "required": ["prediction", "outcome"],
                            "properties": {"prediction": S("prediction id"), "outcome": {"type": "boolean"}, "note": S("what happened"),
                                           "author": S("agent or human", enum=["agent", "human"])}},
                           t_resolve),
        "cladia_correct": ({"type": "object", "required": ["id", "text"],
                            "properties": {"id": S("entry id to supersede"), "text": S("corrected text"), "why": S("reason"), "confidence": conf,
                                           "tags": tags, "author": S("agent or human", enum=["agent", "human"])}},
                           t_correct),
        "cladia_retract": ({"type": "object", "required": ["id"], "properties": {"id": S("entry id"), "reason": S("why")}}, t_retract),
        "cladia_calibration": ({"type": "object", "properties": {}}, t_calibration),
        "cladia_verify": ({"type": "object", "properties": {}}, t_verify),
    }


DESCRIPTIONS = {
    "cladia_brief": "Read this at the start of a session: preferences, lessons from past mistakes, key facts, decisions, open predictions and calibration.",
    "cladia_recall": "Search remembered facts, preferences, decisions and mistakes by free text, tags or kind.",
    "cladia_remember": "Record a fact (decays over time) or a preference (does not decay). Cite evidence when you can.",
    "cladia_decide": "Record a decision with the reasons and the alternatives considered, so the next session does not relitigate it.",
    "cladia_mistake": "Record something that went wrong and the lesson. These are shown to every future session.",
    "cladia_predict": "Record a falsifiable prediction with a probability and a due date. Resolve it later to build calibration.",
    "cladia_resolve": "Record whether a prediction came true.",
    "cladia_correct": "Supersede an entry with a corrected version. The old entry stays in history.",
    "cladia_retract": "Withdraw an entry that should no longer carry weight.",
    "cladia_calibration": "How well past stated confidence matched reality (Brier score, over/under-confidence by bucket).",
    "cladia_verify": "Check the ledger's hash chain for tampering or corruption.",
}


def handle(led: Ledger, msg: dict[str, Any]) -> dict[str, Any] | None:
    """Handle one JSON-RPC message. Returns a response, or None for notifications."""
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    tools = _tools(led)

    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def err(code, message):
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}

    if method == "initialize":
        return ok({"protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": "cladia", "version": __version__},
                   "instructions": "Call cladia_brief at the start of a session. Record facts, decisions, mistakes and predictions as you work. Resolve predictions when you learn the outcome."})
    if method.startswith("notifications/"):
        return None
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": [{"name": n, "description": DESCRIPTIONS[n], "inputSchema": schema} for n, (schema, _) in tools.items()]})
    if method == "tools/call":
        name = params.get("name")
        if name not in tools:
            return err(-32602, f"unknown tool {name!r}")
        try:
            text = tools[name][1](params.get("arguments") or {})
            return ok({"content": [{"type": "text", "text": text}], "isError": False})
        except KeyError as e:
            return ok({"content": [{"type": "text", "text": f"error: missing required argument {e.args[0]!r}"}], "isError": True})
        except (LedgerError, EntryError, ValueError) as e:
            return ok({"content": [{"type": "text", "text": f"error: {e}"}], "isError": True})
    if mid is None:
        return None
    return err(-32601, f"method not found: {method}")


def serve(led: Ledger, stdin=None, stdout=None) -> None:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            resp = handle(led, msg)
        if resp is not None:
            stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            stdout.flush()
