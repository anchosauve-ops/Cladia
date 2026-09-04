"""Cladia: a lineage of memory for agents.

An append-only, hash-chained ledger of what an agent learned, decided, predicted
and got wrong, with confidence that decays, predictions that are scored, and
human corrections that override without erasing.
"""
from .brief import brief
from .calibration import calibration, verdict
from .ledger import Ledger, LedgerError
from .model import KINDS, Entry, EntryError
from .recall import recall

__version__ = "0.1.0"
__all__ = ["Ledger", "LedgerError", "Entry", "EntryError", "KINDS", "recall", "brief", "calibration", "verdict", "__version__"]
