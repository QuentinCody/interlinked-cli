// Colocated tests for the `ubs_subprocess_shell_true` module. The exhaustive
// suites live in src/harness/__tests__/ubs-subprocess-shell-true.test.ts and
// src/harness/__tests__/adversarial/ubs_subprocess_shell_true.adversarial.test.ts.

import { describe, expect, it } from "vitest";
import { checkSubprocessShellTrue } from "./python-subprocess-shell.js";

describe("checkSubprocessShellTrue (module surface)", () => {
	it("flags a top-level shell=True kwarg and anchors at `shell`", () => {
		const code = ["out = subprocess.run(", "    cmd,", "    shell=True,", ")"].join("\n");
		expect(checkSubprocessShellTrue(code, "src/a.py")).toEqual([{ line: 3, text: "shell=True," }]);
	});

	it("flags an `args=` kwarg command that is not a literal", () => {
		expect(checkSubprocessShellTrue("subprocess.run(args=cmd, shell=True)", "src/a.py")).toHaveLength(1);
	});

	it("does not flag a list/tuple of literal arguments", () => {
		expect(checkSubprocessShellTrue('subprocess.call(["cls"], shell=True)', "src/a.py")).toEqual([]);
		expect(checkSubprocessShellTrue('subprocess.call(("dir", "/b"), shell=True)', "src/a.py")).toEqual([]);
	});

	it("does not flag a literal passed through `args=`", () => {
		expect(checkSubprocessShellTrue('subprocess.run(args="make html", shell=True)', "src/a.py")).toEqual([]);
	});

	it("flags a list that carries a variable element", () => {
		expect(checkSubprocessShellTrue('subprocess.run(["start", url], shell=True)', "src/a.py")).toHaveLength(1);
	});
});
