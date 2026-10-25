// Pins for wrapper stripping in front of git invocations (red-team 2026-10-21:
// the commit gates must recognize git through env/command/VAR=/sudo/sh -c the
// same way the bash arm recognizes write verbs).
import { describe, expect, it } from "vitest";
import { isShellName, unwrapCommand } from "./commit-parse-unwrap.js";

const inner = (cmd: string) => unwrapCommand(cmd.split(" "));

describe("unwrapCommand — positive (must reach the wrapped command)", () => {
	it("P1: strips env / sudo / nice / timeout / xargs / exec flags and their values", () => {
		expect(inner("env -i -u HOME A=1 git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("sudo -u me -- git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("nice -n5 git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("timeout --signal=KILL 30 git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("xargs -I {} git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("/usr/bin/env exec -a x git commit")?.argv).toEqual(["git", "commit"]);
	});

	it("P2: an env -C directory is reported, and inline programs are returned for recursion", () => {
		expect(inner("env --chdir=sub git commit")).toEqual({ argv: ["git", "commit"], cwd: "sub", program: null });
		expect(unwrapCommand(["bash", "-ec", "git commit"])?.program).toBe("git commit");
		expect(unwrapCommand(["sh", "-o", "pipefail", "-c", "git commit"])?.program).toBe("git commit");
		expect(inner("eval git commit")?.program).toBe("git commit");
		expect(unwrapCommand(["env", "-S", "git commit"])?.program).toBe("git commit");
	});

	it("P3: strips keywords, assignments, function headers and case arms", () => {
		expect(inner("then ! git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("A[0]=1 B+=2 git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("f() { git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("case $x in a) git commit")?.argv).toEqual(["git", "commit"]);
		expect(inner("b) git commit")?.argv).toEqual(["git", "commit"]);
		expect(isShellName("/bin/bash")).toBe(true);
	});
});

describe("unwrapCommand — negative (must not invent a command)", () => {
	it("N1: command -v, a bare assignment and a closing keyword run nothing", () => {
		expect(inner("command -v git")).toBeNull();
		expect(inner("A=1")).toBeNull();
		expect(inner("fi")).toBeNull();
	});

	it("N2: a script operand or a plain command is left as the command", () => {
		expect(inner("bash x.sh")).toEqual({ argv: ["bash", "x.sh"], cwd: null, program: null });
		expect(inner("git status")?.argv).toEqual(["git", "status"]);
		expect(inner("env -C $D git commit")?.cwd).toBeNull();
		expect(isShellName("bashful")).toBe(false);
	});
});
