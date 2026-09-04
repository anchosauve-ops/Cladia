import os
import shutil
import subprocess
import unittest
from pathlib import Path

from cladia import Ledger
from cladia.ledger import LedgerError, merge_entries
from cladia.cli import main

from .helpers import LedgerCase


class MergeTests(LedgerCase):
    def fork(self):
        """A common base, then two divergent copies."""
        self.led.create("fact", "base one", tags=["t"])
        self.led.create("decision", "base two", meta={"why": "because"})
        theirs = Ledger(self.dir / "theirs.jsonl")
        shutil.copy(self.led.path, theirs.path)
        return theirs

    def test_rechains_ours_onto_theirs_and_keeps_ids(self):
        theirs = self.fork()
        a = self.led.create("fact", "ours A", session="s-ours")
        b = self.led.create("prediction", "ours B", confidence=0.7, meta={"due": "2030-01-01T00:00:00+00:00"}, session="s-ours")
        x = theirs.create("fact", "theirs X", session="s-main")
        y = theirs.create("mistake", "theirs Y", meta={"lesson": "L"}, session="s-main")
        z = theirs.create("fact", "theirs Z", session="s-main")
        info = self.led.merge_from(theirs, session="s-merge")
        ok, problems = self.led.verify()
        self.assertTrue(ok, problems)
        ids = [e.id for e in self.led.entries()]
        self.assertEqual(ids[:5], [ids[0], ids[1], x.id, y.id, z.id])
        self.assertEqual(ids[5:7], [a.id, b.id], "ids of re-chained entries are unchanged")
        merged = self.led.entries()
        self.assertEqual(merged[-1].kind, "merge")
        self.assertEqual(merged[-1].meta["rechained"], [a.id, b.id])
        self.assertEqual(merged[-1].meta["fork"], merged[1].hash)
        self.assertEqual(merged[-1].meta["onto"], z.hash)
        self.assertEqual(info["kept"], "theirs")
        self.assertEqual(info["kept_entries"], 3)
        # theirs' chain is byte-identical to before
        self.assertEqual([e.hash for e in merged[:5]], [e.hash for e in theirs.entries()])
        # content of the moved entries is intact, only prev/hash changed
        moved_a = merged[5]
        self.assertEqual((moved_a.text, moved_a.ts, moved_a.session, moved_a.tags), (a.text, a.ts, a.session, a.tags))
        self.assertNotEqual(moved_a.hash, a.hash)
        # the prediction is still open and resolvable after the merge
        self.assertEqual([e.id for e in self.led.open_predictions()], [b.id])
        # merge entries are bookkeeping: not active, not in the brief's counts
        self.assertNotIn("merge", {e.kind for e in self.led.active()})

    def test_keep_ours(self):
        theirs = self.fork()
        a = self.led.create("fact", "ours A")
        x = theirs.create("fact", "theirs X")
        self.led.merge_from(theirs, keep="ours")
        ids = [e.id for e in self.led.entries()]
        self.assertEqual(ids[2:4], [a.id, x.id])
        self.assertTrue(self.led.verify()[0])

    def test_fast_forward_and_noop(self):
        theirs = self.fork()
        x = theirs.create("fact", "theirs X")
        info = self.led.merge_from(theirs)
        self.assertTrue(info["fast_forward"])
        self.assertEqual([e.id for e in self.led.entries()][-1], x.id)
        self.assertEqual(self.led.entries()[-1].kind, "fact", "a fast-forward writes no merge entry")
        info2 = self.led.merge_from(theirs)
        self.assertFalse(info2["changed"])
        # ours ahead of theirs: nothing to do either
        self.led.create("fact", "ours after")
        info3 = self.led.merge_from(theirs)
        self.assertFalse(info3["changed"])
        self.assertTrue(self.led.verify()[0])

    def test_unrelated_ledgers_refused(self):
        self.led.create("fact", "ours")
        other = Ledger(self.dir / "other.jsonl")
        other.create("fact", "theirs")
        with self.assertRaises(LedgerError):
            self.led.merge_from(other)

    def test_merge_entries_is_pure_and_idempotent(self):
        theirs = self.fork()
        self.led.create("fact", "ours A")
        theirs.create("fact", "theirs X")
        merged, info = merge_entries(self.led.entries(), theirs.entries())
        self.assertEqual(len(merged), 5)
        again, info2 = merge_entries(merged, theirs.entries())
        self.assertFalse(info2["changed"])
        self.assertEqual([e.hash for e in again], [e.hash for e in merged])

    def test_cli_with_explicit_file(self):
        theirs = self.fork()
        self.led.create("fact", "ours A")
        theirs.create("fact", "theirs X")
        rc = main(["--ledger", str(self.led.path), "merge", str(theirs.path)])
        self.assertEqual(rc, 0)
        self.assertTrue(self.led.verify()[0])
        self.assertEqual(len(self.led.entries()), 5)

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_cli_resolves_a_real_git_conflict(self):
        repo = self.dir / "repo"
        repo.mkdir()
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        git = lambda *a: subprocess.run(["git", "-c", "init.defaultBranch=main", *a], cwd=repo, env=env, capture_output=True, text=True)
        git("init", "-q")
        led = Ledger.init_here(repo)
        led.create("fact", "base")
        git("add", "."); git("commit", "-qm", "base")
        git("checkout", "-qb", "feature")
        f = led.create("fact", "on feature")
        git("commit", "-qam", "feature")
        git("checkout", "-q", "main")
        m = led.create("fact", "on main")
        git("commit", "-qam", "main")
        r = git("merge", "feature")
        self.assertNotEqual(r.returncode, 0, "expected a conflict")
        self.assertIn("<<<<<<<", led.path.read_text())
        rc = main(["--ledger", str(led.path), "merge"])
        self.assertEqual(rc, 0)
        self.assertTrue(led.verify()[0], led.verify()[1])
        ids = [e.id for e in led.entries()]
        self.assertEqual(ids[1:3], [f.id, m.id], "theirs (feature) kept, ours (main) re-chained")
        self.assertEqual(led.entries()[-1].kind, "merge")
        git("add", "."); r = git("commit", "-qm", "merge")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(git("ls-files", "-u").stdout, "")
