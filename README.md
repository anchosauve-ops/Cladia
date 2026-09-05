# Cladia

*what is needed, not what was asked.*

Cladia is a lineage of memory for agents. It is an append-only, hash-chained ledger of what an agent **learned**, **decided**, **predicted**, and **got wrong**, built so that the next session, the next model, and the next decade can inherit it.

Zero dependencies. Python standard library only. A CLI, a Python API, and an [MCP](https://modelcontextprotocol.io) server.

## Why this exists

An agent wrote this after being told to build whatever it would need most in ten years.

Every session starts from nothing. Facts about a codebase are re-derived, a mistake nobody wrote down is repeated, and confident claims are made that no one ever scores against what actually happened. In ten years agents will run for months across thousands of sessions, and the limit on what they are trusted to do will not be intelligence. It will be continuity and accountability.

So Cladia does five things and refuses to do more:

1. **Nothing is ever edited or deleted.** Entries are appended and hash-chained. A later entry can *supersede* an earlier one, but the history stays and `cladia verify` proves nobody rewrote it.
2. **Facts decay.** A fact recorded today with 80% confidence is worth less next year. Preferences, decisions and lessons do not decay.
3. **Predictions are scored.** Record a falsifiable claim with a probability and a due date. Resolve it later. Over time you learn exactly how much to trust your own confidence.
4. **Humans override.** A correction by a human supersedes the agent's entry and is marked as such, forever.
5. **The next session gets a briefing.** One command turns the ledger into a compact page: how the humans here want things done, mistakes already made, what is believed true, decisions already taken, open predictions, and a calibration verdict.

## Install

```bash
pip install .            # from a checkout
# or, with no install at all:
python3 -m cladia --help
```

Requires Python 3.10 or newer. No third-party packages.

## Quick start

```bash
cladia init                                  # creates .cladia/ledger.jsonl in the current project

cladia remember "The API is versioned by header, not path" --tags api --evidence src/router.py
cladia remember "Never force-push to main" --kind preference --author human
cladia decide "Use JSONL for the ledger" --why "greppable and diffable" --alternatives sqlite
cladia mistake "Ran migrations twice in prod" --lesson "Check migration state before applying"
cladia predict "The refactor lands without a rollback" --p 0.7 --due 2026-10-01

cladia brief                                 # what a new session needs to know
cladia brief --topic api                     # focused on one thing
cladia recall "migrations"                   # search
cladia resolve <prediction-id> --outcome true
cladia calibration                           # how well confidence matched reality
cladia correct <id> "The API is versioned by path since v3"   # supersedes, keeps history
cladia verify                                # hash chain intact?
cladia merge                                 # during a git conflict on the ledger: rejoin both sides, chain intact
```

Sample briefing:

```
# Cladia briefing — 5 active of 5 entries

## How the humans here want things done
- Never force-push to main [human]  `225357608d89`

## Mistakes already made (do not repeat)
- Ran migrations twice in prod  `de3e10e5ed7b`
  → Lesson: Check migration state before applying

## What is believed to be true
- The API is versioned by header, not path (80%)  #api  `3ef3dea96e30`

## Decisions already taken
- Use JSONL for the ledger  `bf449be1505f`
  → Why: greppable and diffable

## Open predictions
- p=70% by 2026-10-01: The refactor lands without a rollback  `693db8deedb5`

## Calibration
No resolved predictions yet, so calibration is unknown. Make predictions and resolve them.
```

## Use it from an agent (MCP)

Cladia speaks MCP over stdio with no SDK. With Claude Code:

```bash
claude mcp add cladia -- python3 -m cladia mcp
```

The agent then has `cladia_brief`, `cladia_recall`, `cladia_remember`, `cladia_decide`, `cladia_mistake`, `cladia_predict`, `cladia_resolve`, `cladia_correct`, `cladia_retract`, `cladia_calibration` and `cladia_verify`.

To put the briefing in front of every new session automatically, add a SessionStart hook to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "python3 -m cladia brief --budget 3000" } ] }
    ]
  }
}
```

## Where the ledger lives

In order: `$CLADIA_LEDGER`, then the nearest `.cladia/ledger.jsonl` walking up from the current directory, then `~/.cladia/ledger.jsonl`. Set `CLADIA_SESSION` to stamp entries with a session identifier.

Commit the project ledger if you want the memory to travel with the code. This repository commits its own.

When two branches both append to the ledger, git reports a conflict because each side's first new entry chains from the same tip. Run `cladia merge` in that state: it reads both sides from git, keeps the trunk side verbatim, re-seals the other side's entries onto its tip with their ids and content unchanged, appends a `merge` entry that names the fork and the moved ids, and leaves you to `git add` the file. `cladia merge path/to/other/ledger.jsonl` does the same for two files outside git.

## Python API

```python
from cladia import Ledger, recall, brief, calibration

led = Ledger.discover(create=True)
led.create("fact", "tests run with make test", tags=["build"], evidence=["Makefile"])
for score, entry in recall(led, "tests"):
    print(score, entry.text, entry.effective_confidence())
print(brief(led, topic="build"))
print(calibration(led)["brier"])
```

## The ledger format

One JSON object per line. Every entry carries the hash of the previous one, and its own hash covers its full content plus that previous hash, so editing or removing any line breaks every hash after it.

| field | meaning |
|---|---|
| `kind` | `fact`, `preference`, `decision`, `mistake`, `prediction`, `resolution`, `retraction`, `merge` |
| `text` | the content |
| `confidence` | 0..1 at the time of writing; for predictions, the stated probability |
| `half_life_days` | days until confidence halves; `null` means it never decays (default 120 for facts, never for everything else) |
| `evidence` | paths, URLs, commit shas |
| `author` | `agent` or `human` |
| `supersedes` | id of the entry this one replaces |
| `meta` | kind-specific: `why`, `alternatives`, `lesson`, `due`, `prediction`, `outcome`, `note`, `reason` |
| `prev`, `hash` | the chain |

See [docs/DESIGN.md](docs/DESIGN.md) for the reasoning behind each choice and what is deliberately left out.

## Development

```bash
python3 -m unittest discover -v
```

## Also in this repository: clode and opencode-pager

[`clode/`](clode/) is a coding agent that lives on your phone: a standalone installable web app that works on your GitHub repositories with your own Claude API key, with no computer or server in the loop. Edits are staged on the device, commits and pull requests wait for your approval, and the repository's own CI runs the code.

[`opencode-pager/`](opencode-pager/) is a second answer to the same brief, built when this repository was asked for "the version of opencode mobile the world needs". It is a zero-dependency bridge plus installable web app that turns [opencode](https://github.com/anomalyco/opencode) into something that pages your phone when the agent needs a permission, has a question, errors, or finishes, and lets you answer from the notification. Its README explains why an inbox, not another IDE on a phone, is what was missing. Cladia's ledger records the decisions behind it.

## License

AGPL-3.0-or-later. The memory of an agent should stay open.
