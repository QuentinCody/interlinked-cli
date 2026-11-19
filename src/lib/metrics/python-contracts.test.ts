import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonAvailable } from "./python-measure.js";
import { collectStaticMeasurements } from "./static-measurements.js";

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-py-contracts-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

function config(contracts: unknown[], boundaries: unknown[] = []): string {
	return JSON.stringify({ schemaVersion: 1, contracts, boundaries });
}

const SOURCES = {
	"pkg/__init__.py": "from .api import serve\n", "pkg/api.py": "def serve():\n    return 1\n\n\ndef _private():\n    return 2\n",
	"pkg/star.py": "from .api import *\n", "pkg/listed.py": "__all__ = ['one']\n\n\ndef one():\n    pass\n\n\ndef two():\n    pass\n",
	"pyproject.toml": '[project.scripts]\nrun = "pkg.api:serve"\n',
};

function readings(files: Record<string, string>, id: string) {
	const measured = collectStaticMeasurements(repo(files));
	return { reading: measured.metrics.find(item => item.id === id)!, findings: measured.findings.filter(item => item.metric === id) };
}

describe.skipIf(!pythonAvailable())("contracts.findings for Python", () => {
	it("passes file, export and script contracts that hold and names each failing one", () => {
		const contracts = [
			{ kind: "file", path: "pkg/api.py" }, { kind: "file", path: "pkg/missing.py" },
			{ kind: "export", path: "pkg/api.py", name: "serve" }, { kind: "export", path: "pkg/__init__.py", name: "serve" },
			{ kind: "export", path: "pkg/api.py", name: "_private" }, { kind: "export", path: "pkg/listed.py", name: "two" },
			{ kind: "script", path: "pyproject.toml", name: "run" }, { kind: "script", path: "pyproject.toml", name: "absent" },
		];
		const { reading, findings } = readings({ ...SOURCES, "interlinked.metrics.json": config(contracts) }, "contracts.findings");
		expect(reading).toMatchObject({ state: "measured", numerator: 4, denominator: 8 });
		expect(findings.map(item => item.message).sort()).toEqual([
			"Declared export contract failed: pkg/api.py _private", "Declared export contract failed: pkg/listed.py two",
			"Declared file contract failed: pkg/missing.py ", "Declared script contract failed: pyproject.toml absent",
		]);
	});

	it("is inconclusive for an export that a star import may supply, never a guessed pass or fail", () => {
		const { reading } = readings({ ...SOURCES, "interlinked.metrics.json": config([{ kind: "export", path: "pkg/star.py", name: "serve" }]) }, "contracts.findings");
		expect(reading.state).toBe("inconclusive");
		expect(reading.limitations.join(" ")).toContain("pkg/star.py");
	});
});

describe.skipIf(!pythonAvailable())("architecture.boundaries for Python", () => {
	it("counts an import edge between declared directory prefixes as a violation over all resolved import edges", () => {
		const files = {
			"core/__init__.py": "", "core/model.py": "from web import views\n", "web/__init__.py": "", "web/views.py": "from core import model\n",
			"interlinked.metrics.json": config([], [{ from: "core", forbidden: "web" }]),
		};
		const { reading, findings } = readings(files, "architecture.boundaries");
		expect(reading).toMatchObject({ numerator: 1, denominator: 2 });
		expect(findings.map(item => [item.file, item.message])).toEqual([["core/model.py", "Import of web/views.py violates a declared boundary"]]);
	});

	it("stays not-applicable when no boundary is declared, exactly as for JavaScript", () => {
		const { reading } = readings({ "a.py": "x = 1\n" }, "architecture.boundaries");
		expect(reading.state).toBe("not-applicable");
	});
});
