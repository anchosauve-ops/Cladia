"""The phone app's JavaScript core must hash entries exactly as the Python ledger does.

Extracts the <script id="cladia-core"> block from app/cladia.html, runs it under
Node against this repository's own ledger, and checks that the chain verifies and
that every recomputed hash equals the stored one. Skips when Node is unavailable.
"""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app" / "cladia.html"
LEDGER = ROOT / ".cladia" / "ledger.jsonl"

NODE_DRIVER = r"""
const fs = require("fs");
const core = fs.readFileSync(process.argv[1], "utf8");
const m = core.match(/<script id="cladia-core">([\s\S]*?)<\/script>/);
if (!m) { console.log(JSON.stringify({error: "core script not found"})); process.exit(0); }
const module = {exports: {}};
new Function("module", "crypto", "TextEncoder", m[1])(module, globalThis.crypto, TextEncoder);
const C = module.exports;
const entries = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(JSON.parse);
(async () => {
  const r = await C.verify(entries);
  const lines = entries.map(C.toLine);
  const hashes = [];
  for (const e of entries) hashes.push(await C.computeHash(e));
  console.log(JSON.stringify({ok: r.ok, problems: r.problems, n: entries.length, hashes, lines}));
})();
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class TestAppCompat(unittest.TestCase):
    def run_node(self, ledger_path):
        out = subprocess.run(["node", "-e", NODE_DRIVER, "--", str(APP), str(ledger_path)],
                             capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_repo_ledger_verifies_in_js(self):
        res = self.run_node(LEDGER)
        self.assertNotIn("error", res, res)
        self.assertTrue(res["ok"], res["problems"])
        stored = [json.loads(l)["hash"] for l in LEDGER.read_text().splitlines() if l.strip()]
        self.assertEqual(res["hashes"], stored)

    def test_export_lines_are_byte_identical(self):
        res = self.run_node(LEDGER)
        original = [l for l in LEDGER.read_text().splitlines() if l.strip()]
        self.assertEqual(res["lines"], original)

    def test_python_written_edge_cases_hash_the_same(self):
        import tempfile
        from cladia import Ledger
        with tempfile.TemporaryDirectory() as d:
            led = Ledger(Path(d) / "l.jsonl")
            led.create("fact", "quotes \" and \\ and \n newline and ünïcödé and 日本", tags=["B", "a"], confidence=1.0, evidence=["x/y.py"])
            led.create("preference", "never decays", confidence=0.5, half_life_days=None, author="human")
            led.create("decision", "d", meta={"why": "w", "alternatives": ["p", "q"]}, confidence=0.75)
            led.create("mistake", "m", meta={"lesson": "l"}, confidence=1.0)
            p = led.create("prediction", "pr", confidence=0.3, meta={"due": "2030-01-01T00:00:00+00:00"})
            led.create("resolution", "r", meta={"prediction": p.id, "outcome": False, "note": "n"}, confidence=1.0)
            led.create("fact", "half-life 7.5", half_life_days=7.5, confidence=0.05)
            res = self.run_node(led.path)
            self.assertTrue(res["ok"], res["problems"])
            self.assertEqual(res["lines"], [l for l in led.path.read_text().splitlines() if l.strip()])
