#!/usr/bin/env python3
"""Long-running sidecar for OpenAI's privacy-filter (OPF).

Reads JSONL requests from stdin, writes JSONL responses to stdout. One `OPF`
instance is constructed at startup and reused for the process lifetime so the
multi-second model load amortizes across many scan requests.

Protocol mirrors `src/harness/content-scanner/sidecar-manager.ts`:

  request:   {"id": "<id>", "op": "ping" | "scan" | "shutdown", "text"?: str}
  response:  {"id": "<id>", "ok": true | false,
              "spans"?: [{"label": str, "start": int, "end": int, "text": str}],
              "redacted_text"?: str, "error"?: str}

Optional CLI args (parsed at startup, applied once):
  --viterbi-calibration-path <path>
      Absolute path to a JSON calibration artifact in the schema OPF expects
      (operating_points.default.biases with the six VITERBI_BIAS_KEYS).
      When supplied, the sidecar calls OPF.set_viterbi_decoder() so every
      subsequent scan uses the configured precision/recall operating point.
      Omitted = OPF native default (zero biases).

Prereq: `pip install opf`. If the import fails (package missing, wrong venv),
the sidecar emits one init-failure line and exits — the TS-side manager
treats that as fail-open and disables the scanner for the session.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from opf import OPF  # type: ignore[import-not-found]


def _write(obj: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _ok(req_id: str, payload: dict[str, object]) -> None:
    _write({"id": req_id, "ok": True, **payload})


def _fail(req_id: str | None, msg: str) -> None:
    _write({"id": req_id, "ok": False, "error": msg})


def _build_opf(viterbi_calibration_path: str | None) -> OPF:
    try:
        from opf import OPF  # type: ignore[import-not-found]
    except ImportError as e:
        _fail(None, f"opf not installed: {e}. Run `pip install opf` in this interpreter.")
        sys.exit(2)

    try:
        # CPU-only; macOS lacks MPS support in the shipped OPF runtime.
        opf = OPF(device="cpu")
    except Exception as e:
        _fail(None, f"OPF init failed: {e}\n{traceback.format_exc()}")
        sys.exit(3)

    if viterbi_calibration_path is not None:
        try:
            # Applies the precision/recall biases shipped under
            # sidecars/calibrations/. Failure here is loud: a misconfigured
            # calibration path means the user explicitly asked for a non-
            # default operating point and silently falling back to the
            # built-in defaults would mask the misconfiguration.
            opf.set_viterbi_decoder(calibration_path=viterbi_calibration_path)
        except Exception as e:
            _fail(
                None,
                f"OPF calibration load failed for {viterbi_calibration_path!r}: "
                f"{e}\n{traceback.format_exc()}",
            )
            sys.exit(4)

    return opf


def _handle_scan(opf: OPF, req_id: str, text: object) -> None:
    if not isinstance(text, str):
        _fail(req_id, "scan `text` must be a string")
        return
    try:
        result = opf.redact(text)
        spans = [
            {
                "label": span.label,
                "start": int(span.start),
                "end": int(span.end),
                "text": span.text,
            }
            for span in result.detected_spans
        ]
        redacted = result.redacted_text
        if not isinstance(redacted, str):
            raise ValueError("redacted_text must be a string")
        if any(not isinstance(span[key], str) for span in spans for key in ("label", "text")):
            raise ValueError("span label and text must be strings")
    except Exception as e:
        _fail(req_id, f"scan failed: {e}\n{traceback.format_exc()}")
        return

    _ok(req_id, {"spans": spans, "redacted_text": redacted})


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument(
        "--viterbi-calibration-path",
        dest="viterbi_calibration_path",
        default=None,
        help="Optional OPF Viterbi calibration JSON path.",
    )
    # Tolerate unknown args so future TS-side flag additions don't crash
    # older sidecar binaries during a rolling upgrade.
    namespace, _unknown = parser.parse_known_args(argv)
    return namespace


def main() -> None:
    args = _parse_args(sys.argv[1:])
    opf = _build_opf(args.viterbi_calibration_path)

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except Exception as e:  # malformed JSON
            _fail(None, f"bad JSON: {e}")
            continue

        if not isinstance(req, dict):
            _fail(None, "request must be a JSON object")
            continue

        req_id = req.get("id")
        if not isinstance(req_id, str) or not req_id:
            _fail(None, "request id must be a nonempty string")
            continue
        op = req.get("op")

        if op == "ping":
            _ok(req_id, {})
            continue

        if op == "shutdown":
            _ok(req_id, {})
            return

        if op == "scan":
            _handle_scan(opf, req_id, req.get("text"))
            continue

        _fail(req_id, f"unknown op: {op!r}")


if __name__ == "__main__":
    main()
