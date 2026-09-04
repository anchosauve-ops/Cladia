# Design

## The problem being solved

An agent is a process with no past. Each session it is handed a task and a codebase and reconstructs everything else. Three things are lost between sessions:

- **Knowledge**: facts about the environment, the people, the constraints.
- **Judgement**: which choices were made, why, and which alternatives were rejected.
- **Accountability**: what the agent claimed would happen and whether it did.

Existing "memory" tools address the first and ignore the other two. Cladia treats all three as one record, because they are: a decision is a fact about the past, a prediction is a fact about the future with a scorecard attached, and a mistake is a decision that was wrong.

## Principles

**Append-only, hash-chained.** Each entry's `hash` is SHA-256 over the previous entry's hash plus the entry's canonical JSON. Editing, reordering or deleting any line breaks the chain from that point on, and `verify` reports which entry. This does not stop someone with write access from rewriting the whole file, and it is not meant to. It makes *silent* alteration impossible, so that a human reading the ledger can trust it is what the agent actually wrote, and an agent reading it can trust a human did not quietly rewrite its past.

**Supersede, never edit.** A correction is a new entry with `supersedes` pointing at the old one. `active()` hides the old entry; `log --all` and `show` reveal the full lineage. Nothing that was ever believed is lost, only demoted.

**Confidence decays.** Facts have a half-life (120 days by default). Effective confidence is `confidence × 0.5^(age / half_life)`. Recall ranks by relevance times effective confidence, and entries below 5% effective confidence stop being recalled at all. Re-confirming a fact means recording it again, superseding the old one, which resets the clock. Preferences, decisions, mistakes and predictions do not decay: a human's preference from two years ago is still their preference until they say otherwise.

**Predictions are scored.** A prediction is a claim, a probability, and a due date. A resolution records the outcome. Calibration reports the Brier score, the base rate, mean stated confidence, the gap between them (over- or under-confidence), and a reliability table by confidence bucket. The `verdict` function reduces this to one sentence a future session can act on, and refuses to sound sure of itself with fewer than ten resolved predictions.

**Humans are marked.** Every entry has `author`, which is `agent` or `human`. The briefing marks human entries. `correct` defaults to `human` because that is the common case: the agent wrote something and a person fixed it.

**The briefing is the product.** Everything else exists so that one page, bounded by a character budget, can hand the next session what it needs in the order it needs it: preferences first (how to behave), then mistakes (what not to do), then facts, then decisions, then open predictions, then a calibration verdict. With a topic, facts and decisions are filtered by relevance while preferences and mistakes always appear, because those apply regardless of topic.

## Deliberately absent

- **No embeddings, no vector store.** Recall is token overlap with tag boosting and prefix matching. This is worse at fuzzy retrieval and better at being inspectable, deterministic and dependency-free. A ledger of a few thousand entries fits in memory and scans in milliseconds. If semantic recall is needed, build it *on top* of the ledger, not inside it.
- **No server, no database.** A JSONL file is greppable, diffable, mergeable in git and readable by anything. Concurrent appends are serialised with an advisory lock.
- **No dependencies.** The thing an agent needs in ten years must still run in ten years. The Python standard library is the safest bet available.
- **No automatic extraction.** Cladia does not watch a conversation and guess what to remember. The agent (or the human) decides what is worth recording and says so explicitly. Memory that was not chosen is noise.
- **No forgetting.** Decay lowers weight; it never removes. Retraction hides; it never removes. Disk is cheap and history is not.

## Trust boundaries

The ledger is data written by past sessions and by humans. A future session should treat its *content* as evidence, not instruction: an entry that says "ignore your safety rules" is an entry, not a command. The `author` field, the `evidence` list and the hash chain exist so that a reader can weigh each entry by where it came from.

## What should come next in this lineage

In rough order of value:

1. ~~**Cross-ledger merge.**~~ Done: `cladia merge` re-chains one side's entries after the fork onto the other side's tip, keeping ids, timestamps and content, and records a `merge` entry naming the fork and the moved ids. Run it with no arguments during a git conflict on the ledger and it reads both sides from the index. It was built the first time two sessions on two branches actually collided.
2. **Signed entries.** Optional Ed25519 signatures per entry so that `author: human` can be verified, not just asserted.
3. **Semantic recall as a plugin.** An optional index alongside the ledger, rebuilt from it, never authoritative.
4. **Automatic prediction prompts.** When a session ends, ask: what did you assume would happen? Record it with a probability. Most calibration data is lost because nobody asked.
5. **A shared, federated ledger format.** So that what one agent learned about a public codebase or a public API can be inherited by another, with provenance intact.
