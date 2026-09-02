// ===========================================
// session-state-mutators — direct unit coverage
// ===========================================
// Exercises the leaf mutators directly (bypassing SessionTracker) so each
// lazy-allocation branch, ring-buffer trim, and cap/break condition can be
// pinned in isolation.

import { describe, expect, it } from "vitest";
import {
	acknowledgeChecks,
	appendStubsCapped,
	createFreshSession,
	isAcknowledged,
	mergeVerificationObserved,
	trackCommand,
	trackErrorOutcome,
	trackFileOperations,
	trackToolCall,
} from "../session-state-mutators.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";

const baseEvent = (overrides: Partial<HarnessEvent>): HarnessEvent => ({
	hook_event: "PostToolUse",
	session_id: "mut-session",
	agent_source: "claude",
	tool_name: "Edit",
	tool_input: {},
	timestamp: "2026-08-01T10:00:00Z",
	...overrides,
});

function freshSession(): SessionTrajectory {
	return createFreshSession(baseEvent({}), "mut-session");
}

describe("mergeVerificationObserved", () => {
	it("lazily allocates the target's set and unions in the source's signals", () => {
		const from = freshSession();
		from.verification_observed = new Set(["typecheck", "test"]);
		const to = freshSession();
		delete to.verification_observed;

		mergeVerificationObserved(from, to);

		expect(to.verification_observed).toEqual(new Set(["typecheck", "test"]));
	});

	it("unions into an already-populated target without dropping its members", () => {
		const from = freshSession();
		from.verification_observed = new Set(["lint"]);
		const to = freshSession();
		to.verification_observed = new Set(["build"]);

		mergeVerificationObserved(from, to);

		expect(to.verification_observed).toEqual(new Set(["build", "lint"]));
	});

	it("no-ops when the source has no verification_observed set", () => {
		const from = freshSession();
		delete from.verification_observed;
		const to = freshSession();
		to.verification_observed = new Set(["build"]);

		mergeVerificationObserved(from, to);

		expect(to.verification_observed).toEqual(new Set(["build"]));
	});

	it("no-ops when the source's set is empty", () => {
		const from = freshSession();
		from.verification_observed = new Set();
		const to = freshSession();
		delete to.verification_observed;

		mergeVerificationObserved(from, to);

		expect(to.verification_observed).toBeUndefined();
	});
});

describe("appendStubsCapped", () => {
	it("lazily allocates the target's array and appends a copy of each stub", () => {
		const from = freshSession();
		from.stubs_introduced = [{ file: "a.ts", kind: "todo", snippet: "// TODO" }];
		const to = freshSession();
		delete to.stubs_introduced;

		appendStubsCapped(from, to);

		expect(to.stubs_introduced).toEqual([{ file: "a.ts", kind: "todo", snippet: "// TODO" }]);
		// Must be a copy, not the same reference.
		expect(to.stubs_introduced?.[0]).not.toBe(from.stubs_introduced[0]);
	});

	it("stops appending once the target reaches STUB_INTRODUCED_CAP (50)", () => {
		const from = freshSession();
		from.stubs_introduced = [
			{ file: "extra1.ts", kind: "todo", snippet: "x" },
			{ file: "extra2.ts", kind: "todo", snippet: "y" },
		];
		const to = freshSession();
		to.stubs_introduced = Array.from({ length: 50 }, (_, i) => ({
			file: `f${i}.ts`,
			kind: "todo",
			snippet: "x",
		}));

		appendStubsCapped(from, to);

		expect(to.stubs_introduced).toHaveLength(50);
		expect(to.stubs_introduced?.some((s) => s.file === "extra1.ts")).toBe(false);
	});

	it("no-ops when the source has no stubs_introduced", () => {
		const from = freshSession();
		delete from.stubs_introduced;
		const to = freshSession();
		delete to.stubs_introduced;

		appendStubsCapped(from, to);

		expect(to.stubs_introduced).toBeUndefined();
	});

	it("no-ops when the source's stub list is empty", () => {
		const from = freshSession();
		from.stubs_introduced = [];
		const to = freshSession();
		to.stubs_introduced = [{ file: "keep.ts", kind: "todo", snippet: "z" }];

		appendStubsCapped(from, to);

		expect(to.stubs_introduced).toEqual([{ file: "keep.ts", kind: "todo", snippet: "z" }]);
	});
});

describe("trackToolCall", () => {
	it("counts an mcp__-prefixed tool toward mcp_tools_used, not local_tools_used", () => {
		const session = freshSession();
		trackToolCall(session, baseEvent({ tool_name: "mcp__foo__bar", tool_input: {} }));
		expect(session.mcp_tools_used).toBe(1);
		expect(session.local_tools_used).toBe(0);
	});

	it("counts a non-mcp tool toward local_tools_used", () => {
		const session = freshSession();
		trackToolCall(session, baseEvent({ tool_name: "Read", tool_input: { file_path: "x.ts" } }));
		expect(session.mcp_tools_used).toBe(0);
		expect(session.local_tools_used).toBe(1);
	});

	it("trims tool_sequence to the most recent 20 entries", () => {
		const session = freshSession();
		for (let i = 0; i < 25; i++) {
			trackToolCall(session, baseEvent({ tool_name: "Read", tool_input: { file_path: `f${i}.ts` } }));
		}
		expect(session.tool_sequence).toHaveLength(20);
		expect(session.tool_sequence[0]).toBe("Read:f5.ts");
		expect(session.tool_sequence[19]).toBe("Read:f24.ts");
	});

	it("lazily allocates verification_observed on the first browser-MCP call, then reuses it", () => {
		const session = freshSession();
		delete session.verification_observed;

		trackToolCall(session, baseEvent({ tool_name: "mcp__chrome-devtools__click", tool_input: {} }));
		expect(session.verification_observed).toEqual(new Set(["browser"]));

		// Second call: the set already exists (false branch of the lazy-alloc guard).
		trackToolCall(session, baseEvent({ tool_name: "mcp__chrome-devtools__click", tool_input: {} }));
		expect(session.verification_observed).toEqual(new Set(["browser"]));
	});

	it("does not touch verification_observed for a non-browser tool", () => {
		const session = freshSession();
		delete session.verification_observed;
		trackToolCall(session, baseEvent({ tool_name: "Read", tool_input: { file_path: "x.ts" } }));
		expect(session.verification_observed).toBeUndefined();
	});

	it("is a no-op when the event carries no tool_name", () => {
		const session = freshSession();
		const before = { ...session, tool_call_count: session.tool_call_count };
		trackToolCall(session, baseEvent({ tool_name: undefined }));
		expect(session.tool_call_count).toBe(before.tool_call_count);
		expect(session.tool_sequence).toEqual([]);
	});

	it("derives the tool_sequence target from input.path when file_path is absent", () => {
		const session = freshSession();
		trackToolCall(
			session,
			baseEvent({ tool_name: "Ls", tool_input: { path: "src/deep/nested/dir" } }),
		);
		expect(session.tool_sequence).toEqual(["Ls:nested/dir"]);
	});

	it("derives a shortened npx/npm/git command target", () => {
		const session = freshSession();
		trackToolCall(session, baseEvent({ tool_name: "Bash", tool_input: { command: "npx vitest run" } }));
		trackToolCall(session, baseEvent({ tool_name: "Bash", tool_input: { command: "npm run build" } }));
		trackToolCall(session, baseEvent({ tool_name: "Bash", tool_input: { command: "git status" } }));
		trackToolCall(session, baseEvent({ tool_name: "Bash", tool_input: { command: "ls -la" } }));
		expect(session.tool_sequence).toEqual([
			"Bash:npx vitest",
			"Bash:npm run",
			"Bash:git status",
			"Bash:ls",
		]);
	});

	it("derives the tool_sequence target from input.url", () => {
		const session = freshSession();
		trackToolCall(
			session,
			baseEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com/a/very/long/path/that/exceeds/forty/chars" },
			}),
		);
		expect(session.tool_sequence[0]?.startsWith("WebFetch:https://example.com")).toBe(true);
		expect(session.tool_sequence[0]).toHaveLength("WebFetch:".length + 40);
	});

	it("derives an empty target when tool_input carries no recognized key", () => {
		const session = freshSession();
		trackToolCall(session, baseEvent({ tool_name: "SomeTool", tool_input: {} }));
		expect(session.tool_sequence).toEqual(["SomeTool:"]);
	});

	it("falls back to an empty tool_input object when the event carries none", () => {
		const session = freshSession();
		trackToolCall(session, baseEvent({ tool_name: "SomeTool", tool_input: undefined }));
		expect(session.tool_sequence).toEqual(["SomeTool:"]);
	});
});

describe("trackErrorOutcome", () => {
	it("increments error_count and the per-tool consecutive-failure counter", () => {
		const session = freshSession();
		trackErrorOutcome(session, baseEvent({ tool_outcome: "error", tool_name: "Edit" }));
		expect(session.error_count).toBe(1);
		expect(session.consecutive_tool_failures.get("Edit")).toBe(1);
	});

	it("increments error_count but skips the per-tool counter when tool_name is absent", () => {
		const session = freshSession();
		trackErrorOutcome(session, baseEvent({ tool_outcome: "error", tool_name: undefined }));
		expect(session.error_count).toBe(1);
		expect(session.consecutive_tool_failures.size).toBe(0);
	});

	it("resets the per-tool counter on success", () => {
		const session = freshSession();
		trackErrorOutcome(session, baseEvent({ tool_outcome: "error", tool_name: "Edit" }));
		trackErrorOutcome(session, baseEvent({ tool_outcome: "success", tool_name: "Edit" }));
		expect(session.consecutive_tool_failures.has("Edit")).toBe(false);
		expect(session.error_count).toBe(1);
	});

	it("is a no-op for an unset/other tool_outcome", () => {
		const session = freshSession();
		trackErrorOutcome(session, baseEvent({ tool_name: "Edit" }));
		expect(session.error_count).toBe(0);
	});
});

describe("trackFileOperations — read/write path tracking", () => {
	it("adds only the raw path when it already resolves to itself (absolute path)", () => {
		const session = freshSession();
		const absolute = "/abs/fixture/file.ts";
		trackFileOperations(
			session,
			baseEvent({ tool_name: "Read", tool_input: { file_path: absolute }, cwd: "/abs/fixture" }),
		);
		expect(session.files_read).toEqual(new Set([absolute]));
	});

	it("does not add to files_written when the write outcome was an error", () => {
		const session = freshSession();
		trackFileOperations(
			session,
			baseEvent({
				tool_name: "Edit",
				tool_outcome: "error",
				tool_input: { file_path: "src/failed.ts" },
			}),
		);
		expect(session.files_written.size).toBe(0);
	});

	it("adds only the raw path to files_written when it already resolves to itself (absolute path)", () => {
		const session = freshSession();
		const absolute = "/abs/fixture/written.ts";
		trackFileOperations(
			session,
			baseEvent({
				tool_name: "Edit",
				tool_outcome: "success",
				tool_input: { file_path: absolute },
				cwd: "/abs/fixture",
			}),
		);
		expect(session.files_written).toEqual(new Set([absolute]));
	});
});

describe("trackFileOperations — sequence-detector inputs", () => {
	it("records recent-line-edit/literal-occurrence inputs for a successful PostToolUse Edit", () => {
		const session = freshSession();
		trackFileOperations(
			session,
			baseEvent({
				hook_event: "PostToolUse",
				tool_name: "Edit",
				tool_outcome: "success",
				tool_input: { file_path: "src/seq.ts", new_string: "const x = 1;" },
			}),
		);
		expect(session.recent_line_edits?.has("src/seq.ts")).toBe(true);
		expect(session.recent_line_edits?.get("src/seq.ts")).toHaveLength(1);
	});

	it("does not record sequence inputs when the write outcome was an error", () => {
		const session = freshSession();
		trackFileOperations(
			session,
			baseEvent({
				hook_event: "PostToolUse",
				tool_name: "Edit",
				tool_outcome: "error",
				tool_input: { file_path: "src/seq-failed.ts", new_string: "const x = 1;" },
			}),
		);
		expect(session.recent_line_edits).toBeUndefined();
	});
});

describe("trackFileOperations — pending-completion resolution", () => {
	it("marks a pending completion resolved when the touched file is in affected_files", () => {
		const session = freshSession();
		session.pending_completions.set("src/export.ts", {
			source_file: "src/export.ts",
			affected_files: ["src/consumer.ts", "src/other.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 0,
			description: "export changed",
		});
		trackFileOperations(
			session,
			baseEvent({ tool_name: "Read", tool_input: { file_path: "src/consumer.ts" } }),
		);
		expect(session.pending_completions.get("src/export.ts")?.resolved_files).toEqual(
			new Set(["src/consumer.ts"]),
		);
	});

	it("leaves resolved_files untouched when the touched file is not in affected_files", () => {
		const session = freshSession();
		session.pending_completions.set("src/export.ts", {
			source_file: "src/export.ts",
			affected_files: ["src/consumer.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 0,
			description: "export changed",
		});
		trackFileOperations(
			session,
			baseEvent({ tool_name: "Read", tool_input: { file_path: "src/unrelated.ts" } }),
		);
		expect(session.pending_completions.get("src/export.ts")?.resolved_files).toEqual(new Set());
	});

	it("is a no-op when file_path is absent", () => {
		const session = freshSession();
		trackFileOperations(session, baseEvent({ tool_name: "Read", tool_input: {} }));
		expect(session.files_read.size).toBe(0);
	});

	it("is a no-op when tool_name is absent", () => {
		const session = freshSession();
		trackFileOperations(
			session,
			baseEvent({ tool_name: undefined, tool_input: { file_path: "src/x.ts" } }),
		);
		expect(session.files_read.size).toBe(0);
	});
});

describe("trackFileOperations — acknowledged-checks invalidation on write", () => {
	it("clears acknowledged checks matching the written file's key prefix, leaving others intact", () => {
		const session = freshSession();
		acknowledgeChecks(session, "src/target.ts", ["complexity"]);
		acknowledgeChecks(session, "src/other.ts", ["complexity"]);
		trackFileOperations(
			session,
			baseEvent({
				tool_name: "Edit",
				tool_outcome: "success",
				tool_input: { file_path: "src/target.ts" },
			}),
		);
		expect(session.acknowledged_checks.has("src/target.ts::complexity")).toBe(false);
		expect(session.acknowledged_checks.has("src/other.ts::complexity")).toBe(true);
	});
});

describe("isAcknowledged", () => {
	it("returns true for a previously-acknowledged file+check pair", () => {
		const session = freshSession();
		acknowledgeChecks(session, "src/a.ts", ["complexity"]);
		expect(isAcknowledged(session, "src/a.ts", "complexity")).toBe(true);
	});

	it("returns false for a pair that was never acknowledged", () => {
		const session = freshSession();
		expect(isAcknowledged(session, "src/a.ts", "complexity")).toBe(false);
	});
});

describe("trackCommand", () => {
	it("is a no-op for a non-Bash tool", () => {
		const session = freshSession();
		trackCommand(session, baseEvent({ tool_name: "Read", tool_input: { command: "ls" } }));
		expect(session.commands_run).toEqual([]);
	});

	it("is a no-op when command is absent, even for a Bash tool", () => {
		const session = freshSession();
		trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: {} }));
		expect(session.commands_run).toEqual([]);
	});

	it("treats an undefined tool_name as not-Bash (does not throw)", () => {
		const session = freshSession();
		trackCommand(session, baseEvent({ tool_name: undefined, tool_input: { command: "npm test" } }));
		expect(session.commands_run).toEqual([]);
	});

	it("records a short command verbatim", () => {
		const session = freshSession();
		trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: "ls -la" } }));
		expect(session.commands_run).toEqual(["ls -la"]);
	});

	it("truncates a command longer than 200 chars to 200 chars", () => {
		const session = freshSession();
		const long = `echo ${"x".repeat(300)}`;
		trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: long } }));
		expect(session.commands_run).toEqual([long.slice(0, 200)]);
		expect(session.commands_run[0]).toHaveLength(200);
	});

	it("trims commands_run to the most recent 100 entries", () => {
		const session = freshSession();
		for (let i = 0; i < 105; i++) {
			trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: `echo ${i}` } }));
		}
		expect(session.commands_run).toHaveLength(100);
		expect(session.commands_run[0]).toBe("echo 5");
		expect(session.commands_run[99]).toBe("echo 104");
	});

	it("lazily allocates verification_observed on the first classified command, then reuses it", () => {
		const session = freshSession();
		delete session.verification_observed;
		trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" } }));
		expect(session.verification_observed).toEqual(new Set(["typecheck"]));
		trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: "npx vitest run" } }));
		expect(session.verification_observed).toEqual(new Set(["typecheck", "test"]));
	});

	it("does not touch verification_observed for an unclassified command", () => {
		const session = freshSession();
		delete session.verification_observed;
		trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: "ls -la" } }));
		expect(session.verification_observed).toBeUndefined();
	});
});

// The durable `test_commands_run` list exists to fix a specific defect: a
// characterization command run early in a long session aged out of
// `commands_run`'s 100-entry ring under unrelated Bash traffic, forcing a
// re-run of a command that had already produced a passing signal. These
// cases pin the recognizer (only real test-runner shapes qualify), the cap,
// and that unrelated traffic never evicts an entry from this list.
describe("trackCommand — test_commands_run (durable test-signal list)", () => {
	it("P1: a recognized test-runner command is appended to test_commands_run", () => {
		const session = freshSession();
		trackCommand(
			session,
			baseEvent({ tool_name: "Bash", tool_input: { command: "npx vitest related src/a.ts --run" } }),
		);
		expect(session.test_commands_run).toEqual(["npx vitest related src/a.ts --run"]);
	});

	it("N1: `npm run typecheck` × 150 never enters test_commands_run (bounded, only runner shapes)", () => {
		const session = freshSession();
		for (let i = 0; i < 150; i++) {
			trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: "npm run typecheck" } }));
		}
		expect(session.test_commands_run ?? []).toEqual([]);
		// The unrelated traffic still fills (and trims) the ring buffer as before.
		expect(session.commands_run).toHaveLength(100);
	});

	it("P2: 600 test commands tracked → test_commands_run holds the newest 500 (bounded)", () => {
		const session = freshSession();
		for (let i = 0; i < 600; i++) {
			trackCommand(
				session,
				baseEvent({ tool_name: "Bash", tool_input: { command: `npx vitest run src/f${i}.test.ts` } }),
			);
		}
		expect(session.test_commands_run).toHaveLength(500);
		expect(session.test_commands_run?.[0]).toBe("npx vitest run src/f100.test.ts");
		expect(session.test_commands_run?.[499]).toBe("npx vitest run src/f599.test.ts");
	});

	it("N2: a test command's text is truncated at 2000 chars, not commands_run's 200", () => {
		const session = freshSession();
		const long = `npx vitest run src/${"a".repeat(2100)}.test.ts`;
		trackCommand(session, baseEvent({ tool_name: "Bash", tool_input: { command: long } }));
		expect(session.test_commands_run?.[0]).toHaveLength(2000);
		// commands_run keeps its own, shorter, independent truncation.
		expect(session.commands_run[0]).toHaveLength(200);
	});
});
