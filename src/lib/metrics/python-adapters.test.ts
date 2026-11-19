import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonAvailable } from "./python-measure.js";
import { collectStaticMeasurements } from "./static-measurements.js";

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-py-adapters-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

const BODY = (name: string) => `def ${name}(items):\n    out = []\n    for item in items:\n        if item.ready and item.value > 10:\n            out.append(item.value * 2 + len(out))\n    return sorted(out, reverse=True)[:10]\n`;
const metric = (root: string, id: string) => {
	const measured = collectStaticMeasurements(root);
	return { reading: measured.metrics.find(item => item.id === id)!, measured };
};

describe.skipIf(!pythonAvailable())("Python scoring adapters through collectStaticMeasurements", () => {
	it("measures the structure metrics and file metrics for a Python-only repository", () => {
		const root = repo({ "pkg/__init__.py": "", "pkg/calc.py": BODY("calc") });
		for (const id of ["cyclomatic", "cognitive", "tokens", "difficulty", "file.lines", "file.top_level"]) {
			expect(metric(root, id).reading, id).toMatchObject({ state: "measured" });
		}
		expect(metric(root, "cyclomatic").reading).toMatchObject({ value: 4, measuredEntities: 1, eligibleEntities: 1 });
		expect(metric(root, "cyclomatic").reading.top).toMatchObject({ file: "pkg/calc.py", name: "calc", line: 1 });
		expect(metric(root, "file.lines").reading).toMatchObject({ measuredEntities: 2, eligibleEntities: 2 });
		expect(collectStaticMeasurements(root).analysis.gaps).toEqual([]);
	});

	it("finds exact clone bodies across files regardless of the function name, with related locations", () => {
		const root = repo({ "a.py": BODY("first"), "b.py": BODY("second"), "c.py": "def other(x):\n    return x\n" });
		const { reading, measured } = metric(root, "redundancy.clones");
		expect(reading.state).toBe("measured");
		expect(reading.numerator).toBeGreaterThan(0);
		const finding = measured.findings.find(item => item.metric === "redundancy.clones")!;
		expect(finding.related.sort()).toEqual(["a.py:1", "b.py:1"]);
	});

	it("flags a literal that is overwritten before it is read and counts initializers as opportunities", () => {
		const root = repo({ "m.py": "def f(a):\n    total = 0\n    total = a + 1\n    count = 0\n    count += a\n    return total + count\n" });
		const { reading, measured } = metric(root, "redundancy.dead_stores");
		expect(reading).toMatchObject({ state: "measured", numerator: 1, denominator: 3 });
		expect(measured.findings.filter(item => item.metric === "redundancy.dead_stores").map(item => [item.file, item.line])).toEqual([["m.py", 2]]);
	});

	it("measures import cycles between first-party modules and stays external for unknown imports", () => {
		const root = repo({ "pkg/__init__.py": "", "pkg/a.py": "from . import b\nimport numpy\n", "pkg/b.py": "from pkg import a\n", "pkg/c.py": "import json\n" });
		const cycles = metric(root, "architecture.cycles").reading;
		expect(cycles).toMatchObject({ state: "measured", numerator: 2, denominator: 4 });
		const findings = collectStaticMeasurements(root).findings.filter(item => item.metric === "architecture.cycles").map(item => item.file).sort();
		expect(findings).toEqual(["pkg/a.py", "pkg/b.py"]);
	});

	it("reads explicit Any over annotated slots", () => {
		const root = repo({ "t.py": "from typing import Any\n\ndef f(a: int, b: Any) -> str:\n    return str(a)\n" });
		expect(metric(root, "types.unsafe").reading).toMatchObject({ state: "measured", numerator: 1, denominator: 3 });
	});

	it("says explicitly that test integrity is not measured for Python and that reachability without an entry point is inconclusive", () => {
		const root = repo({ "pkg/m.py": BODY("m"), "tests/test_m.py": "def test_m():\n    assert True\n" });
		const { measured } = metric(root, "correctness.findings");
		const read = (id: string) => measured.metrics.find(item => item.id === id)!;
		expect(read("correctness.findings")).toMatchObject({ state: "not-applicable" });
		expect(read("correctness.findings").limitations.join(" ")).toContain("Python");
		expect(read("tests.integrity").state).toBe("missing");
		expect(read("tests.integrity").limitations.join(" ")).toContain("Python");
		expect(read("tests.integrity").limitations.join(" ")).not.toContain("No supported test files");
		expect(read("redundancy.unused")).toMatchObject({ state: "inconclusive" });
		expect(read("redundancy.unused").limitations.join(" ")).toContain("Python entry points");
		expect(read("redundancy.disconnected").limitations.join(" ")).toContain("Python");
	});

	it("keeps a syntax-error file as a gap while measuring the rest", () => {
		const root = repo({ "ok.py": BODY("ok"), "bad.py": "def (:\n" });
		const { analysis } = collectStaticMeasurements(root);
		expect(analysis.gaps.map(gap => gap.path)).toEqual(["bad.py"]);
		expect(analysis.files.map(file => file.input.path)).toEqual(["ok.py"]);
	});
});
