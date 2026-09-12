import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessDecision } from "../harness/types.js";
import type { UnifiedHookEvent } from "../harness/unified-event.js";
import {
	deriveLastCheckFields,
	extractEventFile,
	formatLastCheckLine,
	type LastCheckFields,
	writeLastCheckArtifact,
	writeNoHarnessArtifact,
} from "./last-check-writer.js";

function makeEvent(overrides: {
	phase?: UnifiedHookEvent["phase"];
	toolName?: string;
	toolInput?: unknown;
	kind?: "tool_call" | "shell_command";
	cwd?: string;
}): UnifiedHookEvent {
	const cwd = overrides.cwd ?? "/repo";
	const action: UnifiedHookEvent["action"] =
		overrides.kind === "shell_command"
			? { kind: "shell_command", command: "rm -rf /", tool_class: "side-effect", cwd }
			: {
					kind: "tool_call" as const,
					tool_name: overrides.toolName ?? "edit",
					tool_class: "modify",
					tool_input:
						"toolInput" in overrides
							? overrides.toolInput
							: { file_path: "/repo/src/a.ts" },
					tool_input_redacted: null,
				};
	return {
		schema_version: "1",
		event_id: "e1",
		session_id: "s1",
		ts: "2026-06-12T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: overrides.phase ?? "pre-tool",
		action,
		context: { cwd },
		raw: null,
	};
}

describe("formatLastCheckLine", () => {
	it("joins key=value with pipes, skipping empties and sanitizing delimiters", () => {
		const line = formatLastCheckLine({
			result: "block",
			tool: "Bash",
			file: "",
			summary: "BLOCKED: a | b\nsecond line",
			rule: "builtin-x",
		});
		expect(line).toBe("result=block | tool=Bash | summary=BLOCKED: a   b second line | rule=builtin-x");
	});

	it("skips nullish values, trims sanitized values, and collapses delimiter runs", () => {
		// SAFETY: null is intentionally supplied to verify the writer's runtime boundary.
		const line = formatLastCheckLine({
			result: "clean",
			tool: undefined,
			file: null,
			summary: "  before|||\r\n\nafter  ",
			count: 0,
			ms: 0,
		} as unknown as LastCheckFields);
		expect(line).toBe("result=clean | summary=before after | count=0 | ms=0");
	});
});

describe("extractEventFile", () => {
	it("returns the cwd-relative file for tool calls and empty for shell commands", () => {
		expect(extractEventFile(makeEvent({}))).toBe("src/a.ts");
		expect(
			extractEventFile(makeEvent({ toolInput: { notebook_path: "/repo/n.ipynb" } })),
		).toBe("n.ipynb");
		expect(extractEventFile(makeEvent({ toolInput: { other: 1 } }))).toBe("");
		expect(extractEventFile(makeEvent({ kind: "shell_command" }))).toBe("");
	});

	it("rejects malformed or non-tool-call inputs without throwing", () => {
		const shellWithInput = makeEvent({ kind: "shell_command" });
		// SAFETY: malformed action shape exercises the public runtime guard.
		(shellWithInput as unknown as { action: { kind: string; tool_input: unknown } }).action = {
			kind: "shell_command",
			tool_input: { file_path: "/repo/should-not-be-used.ts" },
		};
		expect(extractEventFile(shellWithInput)).toBe("");
		expect(extractEventFile(makeEvent({ toolInput: null }))).toBe("");
		expect(extractEventFile(makeEvent({ toolInput: { file_path: 42 } }))).toBe("");

		const missingAction = makeEvent({});
		// SAFETY: malformed event shape exercises the public runtime guard.
		missingAction.action = undefined as never;
		expect(extractEventFile(missingAction)).toBe("");

		const missingContext = makeEvent({ toolInput: { file_path: "/repo/src/a.ts" } });
		// SAFETY: malformed event shape exercises the public runtime guard.
		missingContext.context = undefined as never;
		expect(extractEventFile(missingContext)).toBe("/repo/src/a.ts");
	});

	it("only relativizes paths when cwd is non-empty and the path is inside it", () => {
		expect(
			extractEventFile(
				makeEvent({ cwd: "", toolInput: { file_path: "/repo/src/a.ts" } }),
			),
		).toBe("/repo/src/a.ts");
		expect(
			extractEventFile(
				makeEvent({ cwd: "/repo", toolInput: { file_path: "/other/src/a.ts" } }),
			),
		).toBe("/other/src/a.ts");
	});
});

describe("deriveLastCheckFields", () => {
	it("records a post-tool block even when the decision has no rule identifier", () => {
		expect(deriveLastCheckFields(makeEvent({ phase: "post-tool" }), { decision: "block" }, 9)).toEqual({
			result: "block", tool: "edit", file: "src/a.ts", ms: 9,
		});
	});
	it("maps a pre-tool block with first-line summary capped at 80 chars and the rule id", () => {
		const decision: HarnessDecision = {
			decision: "block",
			reason: `${"x".repeat(120)}\nrest`,
			rule_id: "builtin-kill-multi-pid",
		};
		const f = deriveLastCheckFields(makeEvent({ kind: "shell_command" }), decision, 12);
		expect(f).toMatchObject({ result: "block", tool: "Bash", rule: "builtin-kill-multi-pid" });
		expect(f?.summary).toHaveLength(80);
	});

	it("uses the fallback summary, splits bare LF lines, and omits empty optional fields", () => {
		const fallback = deriveLastCheckFields(
			makeEvent({}),
			{ decision: "block", reason: "" },
			12,
		);
		expect(fallback).toMatchObject({
			result: "block",
			summary: "Blocked by Interlinked guard",
		});

		const firstLine = deriveLastCheckFields(
			makeEvent({}),
			{ decision: "block", reason: "first line\nsecond line" },
			12,
		);
		expect(firstLine?.summary).toBe("first line");

		const emptySummary = deriveLastCheckFields(
			makeEvent({}),
			{ decision: "block", reason: "\ncontinued", rule_id: "" },
			12,
		);
		expect(emptySummary).not.toHaveProperty("summary");
		expect(emptySummary).not.toHaveProperty("rule");
	});

	it("uses the action tool name and falls back for empty or malformed actions", () => {
		const named = deriveLastCheckFields(
			makeEvent({ phase: "post-tool", toolName: "write" }),
			{ decision: "allow" },
			9,
		);
		expect(named?.tool).toBe("write");
		const shell = deriveLastCheckFields(
			makeEvent({ phase: "post-tool", kind: "shell_command" }),
			{ decision: "allow" },
			9,
		);
		expect(shell?.tool).toBe("Bash");

		const emptyName = deriveLastCheckFields(
			makeEvent({ phase: "post-tool", toolName: "" }),
			{ decision: "allow" },
			9,
		);
		expect(emptyName?.tool).toBe("tool");

		const missingAction = makeEvent({ phase: "post-tool" });
		// SAFETY: malformed event shape exercises tool-label fallback behavior.
		missingAction.action = undefined as never;
		const malformed = deriveLastCheckFields(missingAction, { decision: "allow" }, 9);
		expect(malformed?.tool).toBe("tool");
	});

	it("treats omitted warnings as clean", () => {
		expect(
			deriveLastCheckFields(makeEvent({ phase: "post-tool" }), { decision: "allow" }, 88),
		).toEqual({ result: "clean", tool: "edit", file: "src/a.ts", ms: 88 });
	});

	// test-contract: invariant — Grok 2026-08-28 issue 11: a post-tool BLOCK with
	// an EMPTY warning list must never render clean; the model sees the block
	// (the .mjs and claude-code adapter branch on decision first) and the
	// statusline must agree.
	it("P: post-tool block with warnings: [] writes result=block, never clean", () => {
		expect(
			deriveLastCheckFields(
				makeEvent({ phase: "post-tool" }),
				{ decision: "block", warnings: [], rule_id: "per-edit-mutation" },
				42,
			),
		).toEqual({ result: "block", tool: "edit", file: "src/a.ts", ms: 42, rule: "per-edit-mutation" });
	});

	it("maps post-tool warnings to warn (with count) and no warnings to clean (with ms)", () => {
		const warn = deriveLastCheckFields(
			makeEvent({ phase: "post-tool" }),
			{ decision: "allow", warnings: ["a", "b"] },
			240,
		);
		expect(warn).toMatchObject({ result: "warn", count: 2, ms: 240, file: "src/a.ts" });
		const clean = deriveLastCheckFields(
			makeEvent({ phase: "post-tool" }),
			{ decision: "allow", warnings: [] },
			88,
		);
		expect(clean).toMatchObject({ result: "clean", ms: 88 });
	});

	it("returns null for pre-tool allow/ask and lifecycle phases", () => {
		expect(deriveLastCheckFields(makeEvent({}), { decision: "allow" }, 5)).toBeNull();
		expect(deriveLastCheckFields(makeEvent({}), { decision: "ask" }, 5)).toBeNull();
		expect(
			deriveLastCheckFields(makeEvent({ phase: "session-start" }), { decision: "allow" }, 5),
		).toBeNull();
	});
});

describe("writeLastCheckArtifact", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lastcheck-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the line for a qualifying event and skips non-qualifying ones", () => {
		writeLastCheckArtifact(
			dir,
			makeEvent({ phase: "post-tool" }),
			{ decision: "allow", warnings: ["w"] },
			31,
		);
		const body = readFileSync(join(dir, "last-check.txt"), "utf8");
		expect(body).toContain("result=warn");
		expect(body).toContain("count=1");
		// Pre-tool allow must not clobber the file.
		writeLastCheckArtifact(dir, makeEvent({}), { decision: "allow" }, 2);
		expect(readFileSync(join(dir, "last-check.txt"), "utf8")).toContain("result=warn");
	});

	it("writes no_harness for post-tool daemon outages and skips pre-tool ones", () => {
		writeNoHarnessArtifact(dir, makeEvent({ phase: "post-tool" }), 17);
		const body = readFileSync(join(dir, "last-check.txt"), "utf8");
		expect(body).toContain("result=no_harness");
		expect(body).toContain("ms=17");
		writeNoHarnessArtifact(dir, makeEvent({}), 3);
		expect(readFileSync(join(dir, "last-check.txt"), "utf8")).toContain("result=no_harness");
	});

	it("swallows filesystem errors and does not create artifacts for skipped phases", () => {
		const missingDir = join(dir, "missing");
		expect(() =>
			writeNoHarnessArtifact(missingDir, makeEvent({ phase: "post-tool" }), 17),
		).not.toThrow();
		expect(() =>
			writeLastCheckArtifact(missingDir, makeEvent({ phase: "post-tool" }), {
				decision: "allow",
				warnings: ["warning"],
			}, 17),
		).not.toThrow();

		writeNoHarnessArtifact(dir, makeEvent({}), 3);
		writeLastCheckArtifact(dir, makeEvent({}), { decision: "allow" }, 3);
		expect(existsSync(join(dir, "last-check.txt"))).toBe(false);
	});
});
