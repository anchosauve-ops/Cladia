import io
import json
from contextlib import redirect_stderr, redirect_stdout

from cladia.cli import main
from .helpers import LedgerCase


class TestCLI(LedgerCase):
    def run_cli(self, *argv, expect=0):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = main(["--ledger", str(self.led.path), *argv])
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else 1
                if isinstance(e.code, str):
                    err.write(e.code)
        self.assertEqual(code, expect, err.getvalue() + out.getvalue())
        return out.getvalue()

    def run_json(self, *argv, expect=0):
        return json.loads(self.run_cli("--json", *argv, expect=expect))

    def test_full_workflow(self):
        f = self.run_json("remember", "the build uses make", "--tags", "build,tooling", "--evidence", "Makefile")
        self.assertEqual(f["kind"], "fact")
        self.assertEqual(f["tags"], ["build", "tooling"])
        self.assertEqual(f["evidence"], ["Makefile"])
        p = self.run_json("remember", "use british spelling", "--kind", "preference", "--author", "human")
        self.assertIsNone(p["half_life_days"])
        d = self.run_json("decide", "use make", "--why", "already there", "--alternatives", "just", "cmake")
        self.assertEqual(d["meta"]["alternatives"], ["just", "cmake"])
        m = self.run_json("mistake", "forgot to run tests", "--lesson", "run make test")
        self.assertEqual(m["confidence"], 1.0)
        pr = self.run_json("predict", "CI passes", "--p", "0.7", "--due", "2026-01-01")
        self.assertEqual(pr["meta"]["due"], "2026-01-01T00:00:00+00:00")

        out = self.run_cli("recall", "make")
        self.assertIn("use make", out)
        self.assertIn("the build uses make", out)

        r = self.run_cli("resolve", pr["id"][:6], "--outcome", "yes", "--note", "green")
        self.assertIn("right", r)
        self.run_cli("resolve", pr["id"], "--outcome", "no", expect=1)  # already resolved

        c = self.run_json("correct", f["id"], "the build uses just", "--why", "migrated")
        self.assertEqual(c["supersedes"], f["id"])
        self.assertEqual(c["author"], "human")
        self.assertEqual(c["tags"], ["build", "tooling"])
        self.assertNotIn("uses make", self.run_cli("log"))
        self.assertIn("uses make", self.run_cli("log", "--all"))

        self.run_json("retract", d["id"], "--reason", "changed mind")
        self.assertNotIn("decision", self.run_cli("log"))

        show = self.run_cli("show", c["id"])
        self.assertIn("lineage", show)
        self.assertIn(f["id"], show)

        b = self.run_cli("brief")
        self.assertIn("british spelling", b)
        self.assertIn("run make test", b)
        self.assertIn("Brier", b)

        cal = self.run_json("calibration")
        self.assertEqual(cal["resolved"], 1)

        v = self.run_json("verify")
        self.assertTrue(v["ok"])
        self.assertEqual(v["entries"], 8)

    def test_verify_exit_code_on_tamper(self):
        self.run_cli("remember", "x")
        self.led.path.write_text(self.led.path.read_text().replace('"x"', '"y"'))
        out = self.run_cli("verify", expect=2)
        self.assertIn("BROKEN", out)

    def test_bad_inputs(self):
        self.run_cli("predict", "x", "--p", "0.5", "--due", "soon", expect=1)
        self.run_cli("resolve", "nope", "--outcome", "true", expect=1)
        self.run_cli("show", "nope", expect=1)
        self.run_cli("remember", "x", "--confidence", "7", expect=1)

    def test_init_and_where(self):
        out = self.run_cli("init", str(self.dir / "proj"))
        self.assertIn(".cladia", out)
        self.assertTrue((self.dir / "proj" / ".cladia" / "ledger.jsonl").exists())
        self.assertIn(str(self.led.path), self.run_cli("where"))

    def test_half_life_zero_means_never(self):
        e = self.run_json("remember", "eternal", "--half-life", "0")
        self.assertIsNone(e["half_life_days"])
        e = self.run_json("remember", "brief", "--half-life", "7")
        self.assertEqual(e["half_life_days"], 7.0)
