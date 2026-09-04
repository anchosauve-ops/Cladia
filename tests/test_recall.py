from datetime import datetime, timedelta, timezone

from cladia import recall
from cladia.recall import match_score, tokenize
from .helpers import LedgerCase


class TestRecall(LedgerCase):
    def test_tokenize(self):
        self.assertEqual(tokenize("The Ledger is JSONL, not SQLite."), ["ledger", "jsonl", "sqlite"])

    def test_tag_match_outranks_text_match(self):
        a = self.led.create("fact", "something about storage", tags=["db"])
        b = self.led.create("fact", "uses a db for things")
        hits = recall(self.led, "db")
        self.assertEqual([e.id for _, e in hits], [a.id, b.id])

    def test_tag_match_outranks_text_match_even_when_text_match_is_newer(self):
        # Regression: a 1.0 cap on match_score once tied tag and text matches on single-word
        # queries, so the newer entry won on the recency bonus and CI flaked on second boundaries.
        from cladia.model import Entry
        a = self.led.create("fact", "something about storage", tags=["db"])
        old_ts = (datetime.now(timezone.utc) - timedelta(days=1)).replace(microsecond=0).isoformat()
        self.led._rewrite([Entry.from_dict({**a.body(), "ts": old_ts}).seal("0" * 64)])
        b = self.led.create("fact", "uses a db for things")
        hits = recall(self.led, "db")
        self.assertEqual([e.id for _, e in hits], [a.id, b.id])
        self.assertGreater(hits[0][0] - hits[1][0], 0.15, "the gap must exceed the maximum recency bonus")

    def test_prefix_match(self):
        e = self.led.create("fact", "the deployment pipeline is slow")
        self.assertGreater(match_score(e, ["deploy"]), 0)
        self.assertEqual(match_score(e, ["dep"]), 0)  # too short for prefix

    def test_filters(self):
        f = self.led.create("fact", "alpha", tags=["x"])
        p = self.led.create("preference", "alpha", tags=["x", "y"])
        self.assertEqual({e.id for _, e in recall(self.led, "alpha", kinds=["preference"])}, {p.id})
        self.assertEqual({e.id for _, e in recall(self.led, "alpha", tags=["y"])}, {p.id})
        self.assertEqual({e.id for _, e in recall(self.led, "alpha", tags=["x"])}, {f.id, p.id})

    def test_superseded_not_recalled(self):
        a = self.led.create("fact", "alpha v1")
        b = self.led.create("fact", "alpha v2", supersedes=a.id)
        self.assertEqual([e.id for _, e in recall(self.led, "alpha")], [b.id])

    def test_decayed_entries_drop_out(self):
        old = datetime(2020, 1, 1, tzinfo=timezone.utc)
        self.led.create("fact", "ancient truth", half_life_days=30)
        # rewrite ts to make it old: simplest is to create with an old ts through Entry
        from cladia import Entry
        e = Entry(kind="fact", text="ancient truth", ts=old.isoformat(), half_life_days=30, confidence=0.9)
        self.led.append(e)
        now = old + timedelta(days=365)
        ids = [x.id for _, x in recall(self.led, "ancient", now=now)]
        self.assertNotIn(e.id, ids)

    def test_empty_query_ranks_by_confidence(self):
        lo = self.led.create("fact", "a", confidence=0.3)
        hi = self.led.create("fact", "b", confidence=0.95)
        self.assertEqual([e.id for _, e in recall(self.led, "")], [hi.id, lo.id])

    def test_lesson_and_why_are_searchable(self):
        m = self.led.create("mistake", "it broke", meta={"lesson": "always run the linter"})
        self.assertEqual([e.id for _, e in recall(self.led, "linter")], [m.id])

    def test_limit(self):
        for i in range(5):
            self.led.create("fact", f"thing {i}")
        self.assertEqual(len(recall(self.led, "thing", limit=2)), 2)
