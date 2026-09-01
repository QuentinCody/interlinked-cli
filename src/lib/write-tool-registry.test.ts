import { describe, expect, it } from "vitest";
import { isReadOnlyToolName } from "./hook-read-only-tools.js";
import {
	CLAUDE_CODE_WRITE_TOOLS,
	CODEX_WRITE_TOOLS,
	DIRECT_FILE_EDIT_TOOLS,
	isDirectFileEditTool,
	WRITE_TOOLS,
	writeToolEntry,
} from "./write-tool-registry.js";

describe("write-tool-registry — positive (must classify as a writer)", () => {
	it("P1: every Claude Code write tool is in the registry, Bash on the shell channel", () => {
		expect(CLAUDE_CODE_WRITE_TOOLS).toEqual([
			"Write",
			"Edit",
			"MultiEdit",
			"NotebookEdit",
			"Bash",
		]);
		expect(writeToolEntry("Bash")?.channel).toBe("shell");
	});

	it("P1b: Codex PostToolUse includes only its native writers", () => {
		expect(CODEX_WRITE_TOOLS).toEqual(["Bash", "apply_patch"]);
		for (const name of CODEX_WRITE_TOOLS) {
			expect(isReadOnlyToolName(name)).toBe(false);
		}
	});

	it("P2: MultiEdit is a DIRECT file edit", () => {
		// The drift this registry exists to close: MultiEdit was registered by
		// the adapter and absent from the pipeline's direct-edit list.
		expect(isDirectFileEditTool("MultiEdit")).toBe(true);
		expect(DIRECT_FILE_EDIT_TOOLS).toContain("MultiEdit");
	});

	it("P3: the other-runner patch verbs are direct edits too", () => {
		for (const name of ["apply_patch", "str_replace", "create", "write_file", "edit_file", "write", "edit"]) {
			expect(isDirectFileEditTool(name)).toBe(true);
		}
	});

	it("P4: DIRECT_FILE_EDIT_TOOLS is exactly the direct-channel entries", () => {
		expect(DIRECT_FILE_EDIT_TOOLS).toEqual(
			WRITE_TOOLS.filter((tool) => tool.channel === "direct").map((tool) => tool.name),
		);
		expect(DIRECT_FILE_EDIT_TOOLS.length).toBeGreaterThan(0);
	});
});

describe("write-tool-registry — negative (must NOT classify as a direct edit)", () => {
	it("N1: no read-only tool appears in the registry", () => {
		// The complement invariant. Widening WRITE_TOOLS must never re-admit a
		// Read/Grep/WebFetch to the per-file quality pipeline.
		for (const tool of WRITE_TOOLS) {
			expect(isReadOnlyToolName(tool.name)).toBe(false);
		}
	});

	it("N2: Bash is a writer but NOT a direct edit — it is the obligation channel", () => {
		expect(isDirectFileEditTool("Bash")).toBe(false);
		expect(DIRECT_FILE_EDIT_TOOLS).not.toContain("Bash");
	});

	it("N3: unknown, empty and nullish names resolve to no entry", () => {
		for (const name of ["mcp__filesystem__write_file", "Read", "", null, undefined]) {
			expect(writeToolEntry(name)).toBeUndefined();
			expect(isDirectFileEditTool(name)).toBe(false);
		}
	});

	it("N4: every registry name is unique", () => {
		const names = WRITE_TOOLS.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
	});
});
