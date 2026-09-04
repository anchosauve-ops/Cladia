import io
import json

from cladia.mcp import handle, serve
from .helpers import LedgerCase


class TestMCP(LedgerCase):
    def call(self, name, **args):
        r = handle(self.led, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
        return r["result"]["isError"], r["result"]["content"][0]["text"]

    def test_initialize_and_list(self):
        r = handle(self.led, {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}})
        self.assertEqual(r["result"]["protocolVersion"], "2024-11-05")
        self.assertEqual(r["result"]["serverInfo"]["name"], "cladia")
        self.assertIsNone(handle(self.led, {"jsonrpc": "2.0", "method": "notifications/initialized"}))
        r = handle(self.led, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        names = [t["name"] for t in r["result"]["tools"]]
        self.assertIn("cladia_brief", names)
        self.assertIn("cladia_predict", names)
        for t in r["result"]["tools"]:
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertTrue(t["description"])

    def test_workflow(self):
        err, txt = self.call("cladia_remember", text="db is postgres", tags=["db"], evidence=["docker-compose.yml"])
        self.assertFalse(err, txt)
        fid = txt.split()[-1]
        err, txt = self.call("cladia_decide", text="use asyncpg", why="fast", alternatives=["psycopg"])
        self.assertFalse(err)
        err, txt = self.call("cladia_mistake", text="ran migrations twice", lesson="check state first")
        self.assertFalse(err)
        err, txt = self.call("cladia_predict", text="migration works", p=0.8, due="2026-01-01")
        self.assertFalse(err)
        pid = txt.split()[2]
        err, txt = self.call("cladia_resolve", prediction=pid, outcome=True)
        self.assertFalse(err)
        self.assertIn("Brier", txt)
        err, txt = self.call("cladia_resolve", prediction=pid, outcome=False)
        self.assertTrue(err)
        err, txt = self.call("cladia_correct", id=fid, text="db is postgres 16", why="checked")
        self.assertFalse(err)
        err, txt = self.call("cladia_recall", query="postgres")
        self.assertIn("postgres 16", txt)
        self.assertNotIn("is postgres\n", txt)
        err, txt = self.call("cladia_brief", topic="db")
        self.assertIn("postgres 16", txt)
        self.assertIn("check state first", txt)
        err, txt = self.call("cladia_calibration")
        self.assertEqual(json.loads(txt)["resolved"], 1)
        err, txt = self.call("cladia_verify")
        self.assertIn("OK", txt)
        err, txt = self.call("cladia_retract", id=fid)
        self.assertFalse(err)  # retracting a superseded entry is allowed, just pointless

    def test_errors(self):
        err, txt = self.call("cladia_predict", text="x", p=0.5)
        self.assertTrue(err)
        self.assertIn("missing required argument 'due'", txt)
        err, txt = self.call("cladia_remember", text="x", confidence=3)
        self.assertTrue(err)
        r = handle(self.led, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "nope"}})
        self.assertEqual(r["error"]["code"], -32602)
        r = handle(self.led, {"jsonrpc": "2.0", "id": 1, "method": "bogus"})
        self.assertEqual(r["error"]["code"], -32601)

    def test_serve_stdio(self):
        stdin = io.StringIO("\n".join([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
            "not json",
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "cladia_verify"}}),
        ]) + "\n")
        stdout = io.StringIO()
        serve(self.led, stdin, stdout)
        lines = [json.loads(l) for l in stdout.getvalue().splitlines()]
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0]["result"], {})
        self.assertEqual(lines[1]["error"]["code"], -32700)
        self.assertIn("OK", lines[2]["result"]["content"][0]["text"])
