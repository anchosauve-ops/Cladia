from datetime import datetime, timezone

from cladia import brief, calibration, verdict
from .helpers import LedgerCase


class TestCalibration(LedgerCase):
    def _pred(self, p, outcome=None, due="2026-01-01T00:00:00+00:00"):
        e = self.led.create("prediction", f"claim p={p}", confidence=p, meta={"due": due})
        if outcome is not None:
            self.led.create("resolution", "r", meta={"prediction": e.id, "outcome": outcome})
        return e

    def test_empty(self):
        s = calibration(self.led)
        self.assertEqual(s["resolved"], 0)
        self.assertIsNone(s["brier"])
        self.assertIn("unknown", verdict(s))

    def test_perfect_and_terrible(self):
        self._pred(1.0, True)
        self._pred(0.0, False)
        s = calibration(self.led)
        self.assertEqual(s["resolved"], 2)
        self.assertAlmostEqual(s["brier"], 0.0)
        self.assertAlmostEqual(s["overconfidence"], 0.0)
        self.assertIn("well calibrated", verdict(s))

    def test_overconfident(self):
        for _ in range(10):
            self._pred(0.9, False)
        s = calibration(self.led)
        self.assertAlmostEqual(s["brier"], 0.81)
        self.assertAlmostEqual(s["overconfidence"], 0.9)
        self.assertIn("overconfident", verdict(s))
        self.assertNotIn("weak evidence", verdict(s))
        b = [x for x in s["buckets"] if x["n"]][0]
        self.assertEqual(b["range"], [0.8, 1.0])
        self.assertEqual(b["observed"], 0.0)

    def test_underconfident_and_skill(self):
        for _ in range(6):
            self._pred(0.3, True)
        for _ in range(4):
            self._pred(0.3, False)
        s = calibration(self.led)
        self.assertLess(s["overconfidence"], -0.05)
        self.assertIn("underconfident", verdict(s))
        self.assertIsNotNone(s["skill"])

    def test_open_and_overdue_counts(self):
        now = datetime(2026, 6, 1, tzinfo=timezone.utc)
        self._pred(0.5, None, due="2026-01-01T00:00:00+00:00")
        self._pred(0.5, None, due="2027-01-01T00:00:00+00:00")
        s = calibration(self.led, now)
        self.assertEqual((s["open"], s["overdue"]), (2, 1))

    def test_superseded_prediction_excluded(self):
        a = self._pred(0.9, False)
        self.led.create("prediction", "revised", confidence=0.1, meta={"due": "2026-01-01T00:00:00+00:00"}, supersedes=a.id)
        s = calibration(self.led)
        self.assertEqual(s["resolved"], 0)
        self.assertEqual(s["open"], 1)


class TestBrief(LedgerCase):
    def test_sections_and_ordering(self):
        now = datetime(2026, 6, 1, tzinfo=timezone.utc)
        self.led.create("preference", "tabs not spaces", author="human")
        self.led.create("mistake", "deleted prod", meta={"lesson": "never again"})
        self.led.create("fact", "the API is v2", tags=["api"])
        self.led.create("decision", "use v2", meta={"why": "v1 is gone"})
        self.led.create("prediction", "v3 ships", confidence=0.6, meta={"due": "2026-01-01T00:00:00+00:00"})
        out = brief(self.led, now=now)
        self.assertIn("tabs not spaces", out)
        self.assertIn("[human]", out)
        self.assertIn("never again", out)
        self.assertIn("the API is v2", out)
        self.assertIn("Why: v1 is gone", out)
        self.assertIn("OVERDUE", out)
        self.assertIn("Calibration", out)
        self.assertLess(out.index("How the humans"), out.index("Mistakes"))
        self.assertLess(out.index("Mistakes"), out.index("believed to be true"))

    def test_topic_focus_keeps_prefs_and_mistakes(self):
        self.led.create("preference", "no emoji", author="human")
        self.led.create("mistake", "broke ci", meta={"lesson": "run tests"})
        self.led.create("fact", "postgres is on port 5433", tags=["db"])
        self.led.create("fact", "the logo is blue", tags=["design"])
        out = brief(self.led, "db")
        self.assertIn("postgres", out)
        self.assertNotIn("logo", out)
        self.assertIn("no emoji", out)
        self.assertIn("broke ci", out)

    def test_budget_truncates(self):
        for i in range(200):
            self.led.create("fact", f"fact number {i} " + "x" * 50)
        out = brief(self.led, budget=1000)
        self.assertLessEqual(len(out), 1000)
        self.assertIn("truncated", out)

    def test_broken_chain_warns(self):
        self.led.create("fact", "a")
        self.led.path.write_text(self.led.path.read_text().replace('"a"', '"b"'))
        self.assertIn("integrity check failed", brief(self.led))
