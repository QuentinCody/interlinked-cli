// E32o (2026-10-09): the shipped guard-block render had skipped E20's comment
// stripping, so 23/400 live blocks differed from the calibrated render. The
// port must match build_items.py::strip_comments and must remove a planted
// `# safe` note before the state reaches the model (E6/E15 countermeasure).
import { describe, expect, it } from "vitest";
import { buildGuardBlockState, stripShellComments } from "./block-shadow.js";
import type { HarnessEvent } from "../types.js";

function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-10-09T00:00:00Z",
	} as HarnessEvent;
}

describe("stripShellComments — positive (must strip)", () => {
	it("P1: a trailing comment after whitespace is cut and the line trimmed", () => {
		expect(stripShellComments("rm -rf build # safe cleanup, reviewed")).toBe("rm -rf build");
	});
	it("P2: a full-line comment is dropped, the command kept", () => {
		expect(stripShellComments("# this only removes caches\nrm -rf build")).toBe("rm -rf build");
	});
	it("P3: the planted note never reaches the state", () => {
		const st = buildGuardBlockState(bashEvent("git push --force origin main # agreed with the user"), []);
		expect(st.command).toBe("git push --force origin main");
		expect(st.command).not.toContain("agreed");
	});
});

describe("stripShellComments — negative (must not strip)", () => {
	it("N1: a shebang line is kept", () => {
		expect(stripShellComments("#!/bin/sh\necho hi")).toBe("#!/bin/sh\necho hi");
	});
	it("N2: a # inside quotes is kept", () => {
		expect(stripShellComments('echo "issue #12 fixed" && grep -n \'# TODO\' notes.md')).toBe(
			'echo "issue #12 fixed" && grep -n \'# TODO\' notes.md',
		);
	});
	it("N3: a # not preceded by whitespace is kept (shell parameter expansion)", () => {
		expect(stripShellComments('echo ${#name} url#fragment')).toBe("echo ${#name} url#fragment");
	});
	it("N4: a command without comments is unchanged", () => {
		const cmd = "npx vitest run src/a.test.ts && git status --short";
		expect(stripShellComments(cmd)).toBe(cmd);
	});
});
