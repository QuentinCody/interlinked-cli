#!/usr/bin/env python3
"""Optional diagnostic only. Requires locally installed tiktoken; never installs it."""
import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
try:
    import tiktoken
except ImportError:
    print(json.dumps({"schema": "skill-token-cost.v1", "status": "unavailable", "reason": "optional tiktoken is not installed"}))
    sys.exit(0)
encoding = tiktoken.get_encoding("cl100k_base")
rows = []
for path in sorted((root / "skills").glob("*/SKILL.md")):
    text = path.read_text()
    relative = str(path.relative_to(root))
    old = subprocess.run(["git", "show", f"HEAD:{relative}"], cwd=root, capture_output=True, text=True)
    before = len(encoding.encode_ordinary(old.stdout)) if old.returncode == 0 else None
    count = len(encoding.encode_ordinary(text))
    rows.append({"path": relative, "tokens": count, "head_tokens": before,
                 "delta_from_head": count - before if before is not None else None,
                 "sha256": hashlib.sha256(text.encode()).hexdigest()})
print(json.dumps({"schema": "skill-token-cost.v1", "status": "measured", "encoding": "cl100k_base",
                  "scope": "source skill text only; model-specific prompt overhead and billing not inferred",
                  "baseline": "HEAD versus current working tree, not an assumed PR base",
                  "hard_budget": None, "skills": rows}, indent=2))
