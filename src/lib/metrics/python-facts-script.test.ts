import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PYTHON_FACTS_SCRIPT } from "./python-facts-script.js";
import { pythonAvailable } from "./python-measure.js";

describe("PYTHON_FACTS_SCRIPT", () => {
	it("imports only the standard-library modules that parse text and never loads or runs target code", () => {
		const imports = [...PYTHON_FACTS_SCRIPT.matchAll(/^\s*(?:import|from)\s+([\w.]+)/gm)].map(match => match[1]);
		expect(imports).toEqual(["re"]);
		expect(PYTHON_FACTS_SCRIPT).not.toMatch(/(?<![.\w])(exec|eval|compile|__import__|importlib|subprocess|open)\s*\(/);
	});

	it.skipIf(!pythonAvailable())("byte-compiles as Python so a typo cannot ship silently", () => {
		const probe = spawnSync("python3", ["-I", "-S", "-B", "-c", "import sys; compile(sys.stdin.read(), 'facts', 'exec')"], { input: PYTHON_FACTS_SCRIPT, encoding: "utf8", cwd: "/" });
		expect(probe.stderr).toBe("");
		expect(probe.status).toBe(0);
	});
});
