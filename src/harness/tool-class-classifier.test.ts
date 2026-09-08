import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	BUILTIN_CLASS_RULES,
	BUILTIN_TOOL_NAME_CLASSES,
	classifyCommand,
	classifyFromToolName,
	loadOverrides,
	parseOverrides,
} from "./tool-class-classifier.js";

// ---- Built-in rules -----------------------------------------------------------

describe("classifyCommand — built-in rules side-effect", () => {
	const cases: Array<[string]> = [
		["rm -rf /tmp/foo"],
		["git push origin main"],
		["gh pr merge 123"],
		["wrangler deploy"],
		["terraform apply"],
		["curl -X POST https://api.example.com"],
		["npm publish"],
		["ssh user@host"],
	];
	for (const [cmd] of cases) {
		it(`${cmd} → side-effect`, () => {
			expect(classifyCommand(cmd)).toBe("side-effect");
		});
	}
});

describe("classifyCommand — built-in rules long-running", () => {
	const cases: Array<[string]> = [
		["npm test"],
		["vitest run"],
		["cargo build"],
		["tsc --project tsconfig.json"],
	];
	for (const [cmd] of cases) {
		it(`${cmd} → long-running`, () => {
			expect(classifyCommand(cmd)).toBe("long-running");
		});
	}
});

describe("classifyCommand — built-in rules modify", () => {
	const cases: Array<[string]> = [
		["git commit -m 'x'"],
		["npm install left-pad"],
		["mv foo bar"],
		["rm foo.txt"],
	];
	for (const [cmd] of cases) {
		it(`${cmd} → modify`, () => {
			expect(classifyCommand(cmd)).toBe("modify");
		});
	}
});

describe("classifyCommand — built-in rules read", () => {
	const cases: Array<[string]> = [["ls -la"], ["git status"], ["grep -R 'needle' src/"], ["pwd"]];
	for (const [cmd] of cases) {
		it(`${cmd} → read`, () => {
			expect(classifyCommand(cmd)).toBe("read");
		});
	}
});

describe("classifyCommand — edge cases", () => {
	it("returns unknown for empty strings", () => {
		expect(classifyCommand("")).toBe("unknown");
	});

	it("defaults to modify for unrecognized commands", () => {
		expect(classifyCommand("some-proprietary-tool --flag")).toBe("modify");
	});

	it("exposes a non-empty built-in ruleset with reasons", () => {
		expect(BUILTIN_CLASS_RULES.length).toBeGreaterThan(10);
		for (const r of BUILTIN_CLASS_RULES) expect(r.reason.length).toBeGreaterThan(0);
	});
});

// ---- classifyFromToolName -----------------------------------------------------

describe("classifyFromToolName — Claude Code built-ins", () => {
	it("maps Read to read", () => {
		expect(classifyFromToolName("Read", {})).toBe("read");
	});
	it("maps Edit to modify", () => {
		expect(classifyFromToolName("Edit", {})).toBe("modify");
	});
	it("maps MultiEdit to modify", () => {
		expect(classifyFromToolName("MultiEdit", {})).toBe("modify");
	});
	it("maps Grep to read", () => {
		expect(classifyFromToolName("Grep", {})).toBe("read");
	});
});

describe("classifyFromToolName — Bash routes to command classification", () => {
	it("Bash rm -rf → side-effect", () => {
		expect(classifyFromToolName("Bash", { command: "rm -rf /" })).toBe("side-effect");
	});
	it("Bash git status → read", () => {
		expect(classifyFromToolName("Bash", { command: "git status" })).toBe("read");
	});
	it("Bash mv → modify", () => {
		expect(classifyFromToolName("Bash", { command: "mv a b" })).toBe("modify");
	});
});

describe("classifyFromToolName — Copilot built-ins", () => {
	it("maps read_file to read", () => {
		expect(classifyFromToolName("read_file", {})).toBe("read");
	});
	it("maps edit_file to modify", () => {
		expect(classifyFromToolName("edit_file", {})).toBe("modify");
	});
	it("maps apply_patch to modify", () => {
		expect(classifyFromToolName("apply_patch", {})).toBe("modify");
	});
	it("routes shell to command classification", () => {
		expect(classifyFromToolName("shell", { command: "ls" })).toBe("read");
	});
});

describe("classifyFromToolName — fallback + overrides", () => {
	it("falls back to modify for unknown MCP tools", () => {
		expect(classifyFromToolName("MyCustomTool", { arg: 1 })).toBe("modify");
	});

	it("tool_name_classes override wins", () => {
		const overrides = parseOverrides({
			tool_name_classes: { MyCustomTool: "side-effect" },
			command_substrings: [],
		});
		expect(classifyFromToolName("MyCustomTool", {}, { overrides })).toBe("side-effect");
	});

	it("command_substrings override wins over built-in rules", () => {
		const overrides = parseOverrides({
			tool_name_classes: {},
			command_substrings: [
				{ match: "my-deploy", class: "side-effect", reason: "custom deploy" },
			],
		});
		expect(
			classifyFromToolName("Bash", { command: "my-deploy --env=prod" }, { overrides }),
		).toBe("side-effect");
	});

	it("built-in tool-name map has sensible defaults", () => {
		expect(BUILTIN_TOOL_NAME_CLASSES.read).toBe("read");
		expect(BUILTIN_TOOL_NAME_CLASSES.bash).toBe("unknown");
	});

	it("falls back to the normalized tool name when the exact name has no override", () => {
		const overrides = parseOverrides({
			tool_name_classes: { my_tool_: "side-effect" },
			command_substrings: [],
		});
		// "My-Tool!" normalizes to "my_tool_" — no literal "My-Tool!" key exists,
		// so the lookup must fall through to the normalized form.
		expect(classifyFromToolName("My-Tool!", {}, { overrides })).toBe("side-effect");
	});

	it("returns modify when toolInput has no extractable command field", () => {
		// "task" maps to "unknown" in the built-in table, so classification
		// routes through extractCommandField; a null input must not throw.
		expect(classifyFromToolName("task", null)).toBe("modify");
	});
});

// ---- parseOverrides -----------------------------------------------------------

describe("parseOverrides — basic shapes", () => {
	it("returns empty for null", () => {
		expect(parseOverrides(null)).toEqual({ tool_name_classes: {}, command_substrings: [] });
	});

	it("returns empty for numbers", () => {
		expect(parseOverrides(42)).toEqual({ tool_name_classes: {}, command_substrings: [] });
	});

	it("drops entries with invalid ToolClass values", () => {
		const overrides = parseOverrides({
			tool_name_classes: { X: "not-a-class" },
			command_substrings: [],
		});
		expect(overrides.tool_name_classes).toEqual({});
	});
});

describe("parseOverrides — command_substrings", () => {
	it("keeps valid entries", () => {
		const overrides = parseOverrides({
			command_substrings: [{ match: "yes", class: "read", reason: "fine" }],
		});
		expect(overrides.command_substrings.length).toBe(1);
		expect(nonNull(overrides.command_substrings[0]).reason).toBe("fine");
	});

	it("drops entries missing the match string", () => {
		const overrides = parseOverrides({
			command_substrings: [{ class: "read" }],
		});
		expect(overrides.command_substrings.length).toBe(0);
	});

	it("drops entries with an empty match string", () => {
		const overrides = parseOverrides({
			command_substrings: [{ match: "", class: "read" }],
		});
		expect(overrides.command_substrings.length).toBe(0);
	});

	it("drops entries with an invalid class", () => {
		const overrides = parseOverrides({
			command_substrings: [{ match: "x", class: "bogus" }],
		});
		expect(overrides.command_substrings.length).toBe(0);
	});

	it("drops entries whose match exceeds the length cap", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const overrides = parseOverrides({
			command_substrings: [{ match: "a".repeat(500), class: "read" }],
		});
		expect(overrides.command_substrings.length).toBe(0);
		expect(stderrSpy).toHaveBeenCalled();
		stderrSpy.mockRestore();
	});

	it("respects case_sensitive flag", () => {
		const overrides = parseOverrides({
			command_substrings: [{ match: "MyDeploy", class: "side-effect", case_sensitive: true }],
		});
		expect(classifyCommand("mydeploy", overrides.command_substrings)).toBe("modify");
		expect(classifyCommand("run MyDeploy --foo", overrides.command_substrings)).toBe(
			"side-effect",
		);
	});

	it("ignores a command_substrings value that isn't an array", () => {
		const overrides = parseOverrides({ command_substrings: "not-an-array" });
		expect(overrides.command_substrings).toEqual([]);
	});

	it("drops a command_substrings entry that isn't an object", () => {
		const overrides = parseOverrides({ command_substrings: [42, "oops", null] });
		expect(overrides.command_substrings).toEqual([]);
	});
});

// ---- loadOverrides — IO ------------------------------------------------------

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-cls-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("loadOverrides", () => {
	it("returns empty when file is missing", () => {
		expect(loadOverrides(join(tmp, "missing.json"))).toEqual({
			tool_name_classes: {},
			command_substrings: [],
		});
	});

	it("loads a valid override file from disk", () => {
		const file = join(tmp, "overrides.json");
		writeFileSync(
			file,
			JSON.stringify({
				tool_name_classes: { MyTool: "side-effect" },
				command_substrings: [{ match: "deploy", class: "side-effect" }],
			}),
		);
		const out = loadOverrides(file);
		expect(out.tool_name_classes.MyTool).toBe("side-effect");
		expect(out.command_substrings.length).toBe(1);
	});

	it("returns empty on malformed JSON without throwing", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const file = join(tmp, "bad.json");
		writeFileSync(file, "{not valid json");
		const out = loadOverrides(file);
		expect(out).toEqual({ tool_name_classes: {}, command_substrings: [] });
		expect(stderrSpy).toHaveBeenCalled();
		stderrSpy.mockRestore();
	});

	it("returns empty and warns when the path exists but can't be read as a file", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// A directory passes existsSync() but readFileSync() throws (EISDIR),
		// exercising the safeRead failure path distinct from "missing file".
		const dirAsFile = join(tmp, "not-a-file");
		mkdirSync(dirAsFile);
		const out = loadOverrides(dirAsFile);
		expect(out).toEqual({ tool_name_classes: {}, command_substrings: [] });
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("could not read"));
		stderrSpy.mockRestore();
	});
});
