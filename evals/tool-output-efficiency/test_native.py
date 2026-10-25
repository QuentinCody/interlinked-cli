import json, os, tempfile, unittest
from native import events
class NativeTests(unittest.TestCase):
    def test_dedupe_compaction_and_usage(self):
        rows = [
            {"type":"response_item","payload":{"type":"function_call","name":"read","call_id":"c","arguments":"{}"}},
            {"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"original"}},
            {"type":"compacted","payload":{}},
            {"type":"response_item","payload":{"type":"function_call","name":"read","call_id":"d","arguments":"{}"}},
            {"type":"response_item","payload":{"type":"function_call_output","call_id":"d","output":"original"}},
            {"type":"token_usage_record","payload":{"response_id":"r","usage":{"input_tokens":100,"cached_input_tokens":80}}}]
        rows.append(rows[1]); rows.append(rows[-2])
        with tempfile.NamedTemporaryFile() as f:
            f.write(b"".join(json.dumps(r).encode()+b"\n" for r in rows)); f.flush()
            out = list(events({"path":f.name,"bytes":os.path.getsize(f.name),"provider":"codex"}))
        self.assertEqual([x["epoch"] for x in out if x["kind"]=="output"], [0,1])
        self.assertEqual(out[-1]["usage"]["input"],100)
        self.assertEqual(out[-1]["compactions"],1)

