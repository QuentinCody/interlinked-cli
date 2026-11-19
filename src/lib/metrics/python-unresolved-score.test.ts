import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonAvailable } from "./python-measure.js";
import { collectStaticMeasurements } from "./static-measurements.js";

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-py-unres-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

function readings(root: string) {
	const measured = collectStaticMeasurements(root);
	const pick = (id: string) => measured.metrics.find(item => item.id === id)!;
	return { cycles: pick("architecture.cycles"), reach: pick("architecture.reach"), disconnected: pick("redundancy.disconnected"), unused: pick("redundancy.unused") };
}

const APP = {
	"pyproject.toml": '[project.scripts]\nrun = "app.cli:main"\n',
	"app/__init__.py": "",
	"app/cli.py": "from app.service import work\n\n\ndef main():\n    return work()\n",
	"app/service.py": "def work():\n    return 1\n",
};

describe.skipIf(!pythonAvailable())("graph metrics when a Python import cannot be resolved", () => {
	it("MUST-NOT-FIRE: a resolvable tree with third-party imports is measured", () => {
		const { cycles, reach, disconnected } = readings(repo({ ...APP, "app/net.py": "import requests\nfrom app import service\n" }));
		expect([cycles.state, reach.state, disconnected.state]).toEqual(["measured", "measured", "measured"]);
	});

	it("MUST-FIRE: a missing first-party module makes cycles, reach, disconnected and unused inconclusive, with the reason stated", () => {
		const all = readings(repo({ ...APP, "app/broken.py": "from app.missing import thing\nfrom .gone import other\n" }));
		for (const reading of [all.cycles, all.reach, all.disconnected, all.unused]) {
			expect(reading.state).toBe("inconclusive");
			expect(reading.limitations.join(" ")).toContain("2 imports could not be resolved");
		}
		expect(all.cycles.limitations.join(" ")).toContain("python-module-missing: 1");
		expect(all.cycles.limitations.join(" ")).toContain("python-relative-target-missing: 1");
	});

	it("MUST-FIRE: a computed import_module makes the reachability metrics inconclusive and names the cause", () => {
		const { disconnected } = readings(repo({ ...APP, "app/loader.py": "import importlib\n\n\ndef load(name):\n    return importlib.import_module(name)\n" }));
		expect(disconnected.state).toBe("inconclusive");
		expect(disconnected.limitations.join(" ")).toContain("computed name");
	});
});
