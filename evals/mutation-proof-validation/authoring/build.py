import json, os, sys
# usage: build.py <spec.py> <repoRoot> <outCorpus>
spec, root, out = sys.argv[1:4]
ns = {}
exec(open(spec).read(), ns)
faults = []
ok = True
for i, f in enumerate(ns["FAULTS"], 1):
    path, find, rep, exp, rid, rtext, tests, why = f
    src = open(os.path.join(root, path)).read()
    c = src.count(find)
    if c != 1: print(f"{ns['NAME']}-{i:02d}: find count {c} in {path}"); ok = False
    if find == rep: print(f"{i}: no-op"); ok = False
    for t in tests:
        if not os.path.exists(os.path.join(root, t)): print(f"{i}: missing test {t}"); ok = False
    faults.append({"id": f"{ns['NAME']}-{i:02d}", "path": path, "find": find, "replace": rep, "rationale": why,
                   "requirement": {"id": rid, "text": rtext}, "tests": tests, "origin": "authored", "expected": exp})
from collections import Counter
print(ns["NAME"], len(faults), dict(Counter(f["expected"] for f in faults)), "OK" if ok else "FAIL")
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump({"version": 1, "faults": faults}, open(out, "w"), indent=1)
