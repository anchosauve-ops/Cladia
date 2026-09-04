import json
import os
from datetime import datetime, timedelta, timezone

from cladia import Entry, EntryError, Ledger, LedgerError
from cladia.ledger import GENESIS
from .helpers import LedgerCase


class TestEntry(LedgerCase):
    def test_hash_covers_prev_and_body(self):
        e = Entry(kind="fact", text="x", id="a", ts="2026-01-01T00:00:00+00:00").seal(GENESIS)
        h1 = e.hash
        e2 = Entry(kind="fact", text="x", id="a", ts="2026-01-01T00:00:00+00:00").seal("f" * 64)
        self.assertNotEqual(h1, e2.hash)
        e.text = "y"
        self.assertNotEqual(e.compute_hash(), h1)

    def test_tags_normalised(self):
        e = Entry(kind="fact", text="x", tags=[" Foo", "bar", "foo", ""])
        self.assertEqual(e.tags, ["bar", "foo"])

    def test_validation(self):
        with self.assertRaises(EntryError):
            Entry(kind="nope", text="x").validate()
        with self.assertRaises(EntryError):
            Entry(kind="fact", text="  ").validate()
        with self.assertRaises(EntryError):
            Entry(kind="fact", text="x", confidence=1.5).validate()
        with self.assertRaises(EntryError):
            Entry(kind="prediction", text="x").validate()
        with self.assertRaises(EntryError):
            Entry(kind="prediction", text="x", meta={"due": "not a date"}).validate()
        with self.assertRaises(EntryError):
            Entry(kind="resolution", text="x", meta={"prediction": "a"}).validate()
        with self.assertRaises(EntryError):
            Entry(kind="retraction", text="x").validate()
        Entry(kind="prediction", text="x", meta={"due": "2030-01-01T00:00:00+00:00"}).validate()

    def test_decay(self):
        ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        e = Entry(kind="fact", text="x", confidence=0.8, half_life_days=10, ts=ts.isoformat())
        self.assertAlmostEqual(e.effective_confidence(ts), 0.8)
        self.assertAlmostEqual(e.effective_confidence(ts + timedelta(days=10)), 0.4)
        self.assertAlmostEqual(e.effective_confidence(ts + timedelta(days=20)), 0.2)
        p = Entry(kind="preference", text="x", confidence=0.8, half_life_days=None, ts=ts.isoformat())
        self.assertAlmostEqual(p.effective_confidence(ts + timedelta(days=3650)), 0.8)

    def test_round_trip_ignores_unknown_keys(self):
        d = json.loads(Entry(kind="fact", text="x", half_life_days=None).to_json())
        d["future_field"] = 1
        e = Entry.from_dict(d)
        self.assertIsNone(e.half_life_days)
        self.assertEqual(e.text, "x")


class TestLedger(LedgerCase):
    def test_append_chains_and_verifies(self):
        a = self.led.create("fact", "one")
        b = self.led.create("fact", "two")
        self.assertEqual(a.prev, GENESIS)
        self.assertEqual(b.prev, a.hash)
        ok, problems = self.led.verify()
        self.assertTrue(ok, problems)
        self.assertEqual([e.id for e in self.led.entries()], [a.id, b.id])

    def test_default_half_life_by_kind(self):
        f = self.led.create("fact", "x")
        p = self.led.create("preference", "y")
        f0 = self.led.create("fact", "z", half_life_days=None)
        self.assertEqual(f.half_life_days, 120.0)
        self.assertIsNone(p.half_life_days)
        self.assertIsNone(f0.half_life_days)
        # survives a round trip through disk
        self.assertIsNone(self.led.get(f0.id).half_life_days)

    def test_tamper_detected(self):
        a = self.led.create("fact", "the sky is blue")
        self.led.create("fact", "water is wet")
        raw = self.led.path.read_text().replace("blue", "green")
        self.led.path.write_text(raw)
        ok, problems = self.led.verify()
        self.assertFalse(ok)
        self.assertTrue(any("altered" in p and a.id in p for p in problems))

    def test_deleted_line_detected(self):
        self.led.create("fact", "one")
        self.led.create("fact", "two")
        self.led.create("fact", "three")
        lines = self.led.path.read_text().splitlines()
        self.led.path.write_text("\n".join([lines[0], lines[2]]) + "\n")
        ok, problems = self.led.verify()
        self.assertFalse(ok)
        self.assertTrue(any("prev hash" in p for p in problems))

    def test_supersede_and_active(self):
        a = self.led.create("fact", "v1")
        b = self.led.create("fact", "v2", supersedes=a.id)
        active = self.led.active()
        self.assertEqual([e.id for e in active], [b.id])
        self.assertEqual([e.id for e in self.led.lineage(b.id)], [a.id, b.id])
        self.assertEqual([e.id for e in self.led.descendants(a.id)], [b.id])

    def test_supersede_by_prefix_and_unknown(self):
        a = self.led.create("fact", "v1")
        b = self.led.create("fact", "v2", supersedes=a.id[:6])
        self.assertEqual(b.supersedes, a.id)
        with self.assertRaises(LedgerError):
            self.led.create("fact", "v3", supersedes="zzzzzz")

    def test_retraction_removes_from_active(self):
        a = self.led.create("fact", "wrong")
        self.led.create("retraction", "oops", supersedes=a.id)
        self.assertEqual(self.led.active(), [])
        self.assertEqual(len(self.led.entries()), 2)

    def test_predictions_open_overdue_resolved(self):
        now = datetime(2026, 6, 1, tzinfo=timezone.utc)
        p1 = self.led.create("prediction", "soon", confidence=0.7, meta={"due": "2026-05-01T00:00:00+00:00"})
        p2 = self.led.create("prediction", "later", confidence=0.4, meta={"due": "2027-01-01T00:00:00+00:00"})
        self.assertEqual({e.id for e in self.led.open_predictions(now)}, {p1.id, p2.id})
        self.assertEqual([e.id for e in self.led.overdue_predictions(now)], [p1.id])
        self.led.create("resolution", "yes", meta={"prediction": p1.id, "outcome": True})
        self.assertEqual([e.id for e in self.led.open_predictions(now)], [p2.id])
        self.assertIn(p1.id, self.led.resolutions())

    def test_session_from_env(self):
        os.environ["CLADIA_SESSION"] = "s-123"
        e = self.led.create("fact", "x")
        self.assertEqual(e.session, "s-123")

    def test_discover_walks_up_and_env(self):
        proj = self.dir / "proj" / "sub" / "deep"
        proj.mkdir(parents=True)
        led = Ledger.init_here(self.dir / "proj")
        found = Ledger.discover(proj)
        self.assertEqual(found.path, led.path)
        os.environ["CLADIA_LEDGER"] = str(self.dir / "elsewhere.jsonl")
        self.assertEqual(Ledger.discover(proj).path, self.dir / "elsewhere.jsonl")

    def test_discover_falls_back_to_home(self):
        os.environ["CLADIA_HOME"] = str(self.dir / "home")
        led = Ledger.discover(self.dir, create=True)
        self.assertEqual(led.path, self.dir / "home" / "ledger.jsonl")
        self.assertTrue(led.exists())

    def test_ambiguous_prefix(self):
        a = self.led.create("fact", "a")
        b = self.led.create("fact", "b")
        common = os.path.commonprefix([a.id, b.id])
        if common:
            with self.assertRaises(LedgerError):
                self.led.get(common)
        self.assertIsNone(self.led.get("nonexistent-id"))

    def test_corrupt_line_raises(self):
        self.led.create("fact", "a")
        with self.led.path.open("a") as fh:
            fh.write("{not json\n")
        with self.assertRaises(LedgerError):
            self.led.entries()
