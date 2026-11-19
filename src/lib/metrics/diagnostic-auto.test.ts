import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAutoDiagnosticReport, isMixedDiagnosticReport } from "./diagnostic-auto.js";
import { collectPythonDiagnosticReportAsync } from "./diagnostic-python.js";
import { collectDiagnosticReport } from "./diagnostic-report.js";
import { compareDiagnosticSnapshots } from "./diagnostic-compare.js";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "diagnostic-auto-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const PY = "def worker(items):\n    total = 0\n    for item in items:\n        if item:\n            total += item\n    return total\n";
const TS = "export function worker(items: number[]): number {\n\tlet total = 0;\n\tfor (const item of items) {\n\t\tif (item) total += item;\n\t}\n\treturn total;\n}\n";

describe("auto-selected diagnostic profile", () => {
	it("MUST-FIRE: a Python-only tree reports the Python profile with its own functions and no unsupported-language gaps", async () => {
		put({ "app/worker.py": PY });
		const report = await collectAutoDiagnosticReport(root);
		expect(isMixedDiagnosticReport(report)).toBe(false);
		if (isMixedDiagnosticReport(report)) return;
		expect(report.profile.id).toBe("interlinked-iterative-python-v1");
		expect(report.functions.map(fn => fn.name)).toEqual(["worker"]);
		expect(report.scope).toMatchObject({ status: "complete", measuredFiles: 1, eligibleFiles: 1 });
		expect(report.modelCalls).toBe(0);
	});

	it("MUST-NOT-FIRE: a JavaScript/TypeScript-only tree keeps the JS/TS profile", async () => {
		put({ "src/worker.ts": TS });
		const report = await collectAutoDiagnosticReport(root);
		expect(isMixedDiagnosticReport(report)).toBe(false);
		if (!isMixedDiagnosticReport(report)) expect(report.profile.id).toBe("interlinked-iterative-js-ts-v1");
	});

	it("an empty tree keeps the legacy JS/TS not-applicable shape", async () => {
		put({ "README.md": "# nothing\n" });
		const report = await collectAutoDiagnosticReport(root);
		expect(isMixedDiagnosticReport(report)).toBe(false);
		if (!isMixedDiagnosticReport(report)) expect(report.erosion.state).toBe("not-applicable");
	});

	it("MUST-FIRE: a mixed tree reports one report per language with separate denominators", async () => {
		put({ "src/worker.ts": TS, "tools/worker.py": PY });
		const report = await collectAutoDiagnosticReport(root);
		expect(isMixedDiagnosticReport(report)).toBe(true);
		if (!isMixedDiagnosticReport(report)) return;
		expect(report).toMatchObject({ schemaVersion: 1, modelCalls: 0 });
		const [js, py] = report.profiles;
		expect(js?.profile.id).toBe("interlinked-iterative-js-ts-v1");
		expect(py?.profile.id).toBe("interlinked-iterative-python-v1");
		expect(js?.files.map(file => file.path)).toEqual(["src/worker.ts"]);
		expect(py?.files.map(file => file.path)).toEqual(["tools/worker.py"]);
		expect(js?.scope).toMatchObject({ status: "complete", eligibleFiles: 1 });
		expect(py?.scope).toMatchObject({ status: "complete", eligibleFiles: 1 });
		expect(js?.erosion.denominator).toBeGreaterThan(0);
		expect(py?.erosion.denominator).toBeGreaterThan(0);
		expect(js?.sourceHash).not.toBe(py?.sourceHash);
	});

	it("prints the selection rule, languages and shares, and leaves the measured report unchanged", async () => {
		put({ "src/worker.ts": TS, "src/other.ts": TS, "tools/worker.py": PY });
		const mixed = await collectAutoDiagnosticReport(root);
		expect(mixed.profileSelection).toEqual({ rule: "both-languages", languages: { typescript: 2, python: 1 }, shares: { typescript: 0.6667, python: 0.3333 } });
		rmSync(join(root, "tools"), { recursive: true });
		const jsOnly = await collectAutoDiagnosticReport(root);
		expect(jsOnly.profileSelection.rule).toBe("only-js-ts");
		const { profileSelection: _selection, ...bare } = jsOnly as typeof jsOnly & { profile: unknown };
		expect(bare).toEqual(collectDiagnosticReport(root));
	});

	it("an explicit profile output is identical to the profile collector, with no selection block", async () => {
		put({ "tools/worker.py": PY });
		const explicit = await collectPythonDiagnosticReportAsync(root);
		expect(explicit).not.toHaveProperty("profileSelection");
		const auto = await collectAutoDiagnosticReport(root);
		expect(auto.profileSelection.rule).toBe("only-python");
		const { profileSelection: _selection, ...bare } = auto as typeof auto & { profile: unknown };
		expect(bare).toEqual(explicit);
	});

	it("compare refuses reports measured with different profiles", async () => {
		put({ "src/worker.ts": TS, "tools/worker.py": PY });
		const js = parseDiagnosticSnapshot(collectDiagnosticReport(root));
		const py = parseDiagnosticSnapshot(await collectPythonDiagnosticReportAsync(root));
		const result = compareDiagnosticSnapshots(js, py);
		expect(result.comparable).toBe(false);
		expect(result.reasons.join(";")).toContain("Measurement profiles");
	});

	it("keeps a language the profiles do not support as a gap in each report instead of dropping it", async () => {
		put({ "src/worker.ts": TS, "tools/worker.py": PY, "native/lib.rs": "pub fn f() -> u32 { 1 }\n" });
		const report = await collectAutoDiagnosticReport(root);
		expect(isMixedDiagnosticReport(report)).toBe(true);
		if (!isMixedDiagnosticReport(report)) return;
		for (const profile of report.profiles) {
			expect(profile.scope.status).toBe("partial");
			expect(profile.scope.notMeasured.map(gap => gap.path)).toContain("native/lib.rs");
		}
	});
});
