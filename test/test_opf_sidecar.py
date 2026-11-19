import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "src/harness/content-scanner/sidecars/opf-sidecar.py"


def exchange(lines, model):
    output = io.StringIO()
    args = [str(SCRIPT), "--viterbi-calibration-path", "calibration.json"]
    with patch.dict(sys.modules, {"opf": SimpleNamespace(OPF=lambda *, device: model)}), \
            patch.object(sys, "stdin", io.StringIO("\n".join(lines))), \
            patch.object(sys, "argv", args), contextlib.redirect_stdout(output):
        runpy.run_path(str(SCRIPT), run_name="__main__")
    return [json.loads(line) for line in output.getvalue().splitlines()]


class SidecarProtocolTest(unittest.TestCase):
    def test_invalid_shutdown_id_and_nonserializable_model_output_do_not_end_the_stream(self):
        model = SimpleNamespace(
            set_viterbi_decoder=lambda **kwargs: None,
            redact=lambda _: SimpleNamespace(detected_spans=[], redacted_text=object()),
        )
        responses = exchange([
            '{"op":"shutdown"}', '{"id":3,"op":"shutdown"}',
            '{"id":"scan","op":"scan","text":"hello"}', '{"id":"live","op":"ping"}',
        ], model)
        self.assertEqual([(row["id"], row["ok"]) for row in responses],
                         [(None, False), (None, False), ("scan", False), ("live", True)])

    def test_initializes_once_and_preserves_request_ids_and_redacted_offsets(self):
        calibrated = []
        span = SimpleNamespace(label="person", start=0, end=3, text="Ada")
        model = SimpleNamespace(
            set_viterbi_decoder=lambda *, calibration_path: calibrated.append(calibration_path),
            redact=lambda text: SimpleNamespace(detected_spans=[span], redacted_text="[person]"),
        )
        responses = exchange([
            '{"id":"a","op":"ping"}', '{"id":"b","op":"scan","text":"Ada"}',
            '{"id":"c","op":"shutdown"}', '{"id":"d","op":"ping"}',
        ], model)
        self.assertEqual(calibrated, ["calibration.json"])
        self.assertEqual(responses, [
            {"id": "a", "ok": True},
            {"id": "b", "ok": True, "redacted_text": "[person]",
             "spans": [{"label": "person", "start": 0, "end": 3, "text": "Ada"}]},
            {"id": "c", "ok": True},
        ])

    def test_bad_input_and_malformed_model_result_leave_the_next_request_usable(self):
        seen = []

        def redact(text):
            seen.append(text)
            return SimpleNamespace(detected_spans=[object()], redacted_text="")

        model = SimpleNamespace(set_viterbi_decoder=lambda **kwargs: None, redact=redact)
        responses = exchange([
            "{", '{"id":"type","op":"scan","text":12}', '{"id":"model","op":"scan","text":"Ada"}',
            '{"id":"after","op":"ping"}',
        ], model)
        self.assertEqual(seen, ["Ada"])
        self.assertEqual([(r["id"], r["ok"]) for r in responses],
                         [(None, False), ("type", False), ("model", False), ("after", True)])
        self.assertIn("must be a string", responses[1]["error"])
        self.assertIn("scan failed", responses[2]["error"])
