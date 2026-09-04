import os
import tempfile
import unittest
from pathlib import Path

from cladia import Ledger


class LedgerCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.led = Ledger(self.dir / "ledger.jsonl")
        self._env = {k: os.environ.pop(k, None) for k in ("CLADIA_LEDGER", "CLADIA_SESSION", "CLADIA_HOME")}

    def tearDown(self):
        for k, v in self._env.items():
            if v is not None:
                os.environ[k] = v
        self._tmp.cleanup()
