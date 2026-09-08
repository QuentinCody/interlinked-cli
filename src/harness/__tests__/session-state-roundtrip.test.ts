import { parseWire, wireArray, wireNumber, wireObject, wireRecord, wireString } from "../../lib/value-validation.js";
import { nonNull } from "../../lib/non-null.js";
// ===========================================
// SessionTracker.serialize / hydrate round-trip
// ===========================================
// The two methods MUST be perfect inverses for the live-snapshot durability
// path to work: every field that survives a process restart hinges on this.
// Test diverse state — Maps with complex values, nested Sets inside
// pending_completions, optional fields, the Infinity/null step_limit
// encoding — so a future field addition that forgets either side is caught.

import { describe, expect, it } from "vitest";
import { acknowledgeChecks, SessionTracker } from "../session-state.js";
import { recordSkillEnter } from "../session-skills.js";
import type { HarnessEvent } from "../types.js";

const baseEvent = (overrides: Partial<HarnessEvent>): HarnessEvent => ({
	hook_event: "PostToolUse",
	session_id: "rtt-session",
	agent_name: "alice",
	agent_source: "claude",
	tool_name: "Edit",
	tool_input: {},
	timestamp: "2026-05-05T10:00:00Z",
	...overrides,
});

describe("SessionTracker round-trip", () => {
	it("preserves a freshly-created session unchanged", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({ tool_name: "Read", tool_input: { file_path: "a.ts" } }));
		const snap = writer.serialize("rtt-session");
		expect(snap).not.toBeNull();

		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));
		expect(restored).not.toBeNull();
		expect(restored?.session_id).toBe("rtt-session");
		expect(restored?.tool_call_count).toBe(1);
		expect(restored?.files_read.has("a.ts")).toBe(true);
	});

	it("preserves files_read, files_written, tool counts across multiple events", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } }));
		writer.recordEvent(
			baseEvent({
				tool_name: "Edit",
				tool_input: { file_path: "src/b.ts", old_string: "x", new_string: "y" },
			}),
		);
		writer.recordEvent(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "git status" },
			}),
		);

		const snap = writer.serialize("rtt-session");
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));

		expect(restored?.tool_call_count).toBe(3);
		// Phase 1 path normalization stores BOTH raw + resolved-absolute
		// forms so existing callers that pass either shape still match. For
		// relative inputs that's two entries; absolute inputs collapse to one.
		expect(restored?.files_read.has("src/a.ts")).toBe(true);
		expect(restored?.files_written.has("src/b.ts")).toBe(true);
		expect(restored?.commands_run).toEqual(["git status"]);
		expect(restored?.local_tools_used).toBe(3);
		expect(restored?.mcp_tools_used).toBe(0);
	});

	it("preserves acknowledged_checks and file_edit_counts (the suppression state)", () => {
		const writer = new SessionTracker();
		writer.recordEvent(
			baseEvent({
				tool_name: "Edit",
				tool_input: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
			}),
		);
		const session = writer.get("rtt-session");
		if (session) acknowledgeChecks(session, "src/x.ts", ["typescript", "biome_lint"]);

		const snap = writer.serialize("rtt-session");
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));

		expect(restored?.acknowledged_checks.has("src/x.ts::typescript")).toBe(true);
		expect(restored?.acknowledged_checks.has("src/x.ts::biome_lint")).toBe(true);
		expect(restored?.file_edit_counts.get("src/x.ts")).toBe(1);
	});

	it("encodes Infinity step_limit as null and decodes it back", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		expect(session?.step_limit).toBe(Number.POSITIVE_INFINITY);

		const snap = writer.serialize("rtt-session");
		expect(snap?.step_limit).toBeNull(); // JSON-safe encoding

		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));
		expect(restored?.step_limit).toBe(Number.POSITIVE_INFINITY);
	});

	it("preserves actor_tool_calls (per-actor step counts) so a daemon restart does not reset a budget", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({ tool_name: "Read", tool_input: { file_path: "a.ts" } }));
		writer.recordEvent(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "b.ts" },
				agent_name: "sub-9",
				subagent_id: "sub-9",
			}),
		);
		const snap = writer.serialize("rtt-session");
		const restored = new SessionTracker().hydrate(nonNull(snap));
		expect(restored?.tool_call_count).toBe(2);
		expect(restored?.actor_tool_calls).toEqual(
			new Map([
				["alice", 1],
				["sub-9", 1],
			]),
		);
	});

	it("hydrates a pre-fix snapshot with no actor_tool_calls as absent (total-count fallback), not empty", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const snap = nonNull(writer.serialize("rtt-session"));
		delete snap.actor_tool_calls;
		const restored = new SessionTracker().hydrate(snap);
		expect(restored?.actor_tool_calls).toBeUndefined();
	});

	it("preserves a finite step_limit unchanged", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		if (session) session.step_limit = 25;

		const snap = writer.serialize("rtt-session");
		expect(snap?.step_limit).toBe(25);

		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));
		expect(restored?.step_limit).toBe(25);
	});

	it("preserves nested Set inside pending_completions.resolved_files", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		if (session) {
			session.pending_completions.set("api.ts", {
				source_file: "api.ts",
				affected_files: ["client.ts", "server.ts"],
				resolved_files: new Set(["client.ts"]),
				recorded_at_tool_call: 1,
				description: "API surface change",
			});
		}

		const snap = writer.serialize("rtt-session");
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));

		const pending = restored?.pending_completions.get("api.ts");
		expect(pending?.source_file).toBe("api.ts");
		expect(pending?.affected_files).toEqual(["client.ts", "server.ts"]);
		expect(pending?.resolved_files instanceof Set).toBe(true);
		expect(pending?.resolved_files.has("client.ts")).toBe(true);
		expect(pending?.resolved_files.has("server.ts")).toBe(false);
	});

	it("preserves the previously-missing 'consecutive_tool_failures' counter", () => {
		const writer = new SessionTracker();
		// Phase 1 outcome-aware gating: counter increments on
		// `tool_outcome === "error"` (folded failures land on regular Post*
		// for Claude/Codex/Gemini/Copilot — only Cursor uses the dedicated
		// PostToolUseFailure event). Test both forms to pin the contract.
		writer.recordEvent(
			baseEvent({ hook_event: "PostToolUseFailure", tool_name: "Bash", tool_outcome: "error" }),
		);
		writer.recordEvent(
			baseEvent({ hook_event: "PostToolUse", tool_name: "Bash", tool_outcome: "error" }),
		);
		writer.recordEvent(
			baseEvent({ hook_event: "PostToolUse", tool_name: "Bash", tool_outcome: "error" }),
		);

		const snap = writer.serialize("rtt-session");
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));

		expect(restored?.consecutive_tool_failures.get("Bash")).toBe(3);
	});

	it("preserves nudge guards, doc/non-doc commit cadence counters", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		if (session) {
			session.mid_session_nudge_emitted = true;
			session.stop_nudge_emitted = false;
			session.doc_files_edited_since_commit = 4;
			session.non_doc_files_edited_since_commit = new Set(["src/a.ts", "src/b.ts"]);
		}

		const snap = writer.serialize("rtt-session");
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));

		expect(restored?.mid_session_nudge_emitted).toBe(true);
		expect(restored?.stop_nudge_emitted).toBe(false);
		expect(restored?.doc_files_edited_since_commit).toBe(4);
		expect(restored?.non_doc_files_edited_since_commit?.has("src/a.ts")).toBe(true);
		expect(restored?.non_doc_files_edited_since_commit?.size).toBe(2);
	});

	it("returns null on snapshot missing session_id", () => {
		const reader = new SessionTracker();
		const restored = reader.hydrate({ tool_call_count: 5 });
		expect(restored).toBeNull();
	});

	it("falls back to defaults on unknown sensitivity_level", () => {
		const reader = new SessionTracker();
		const restored = reader.hydrate({
			session_id: "weird",
			sensitivity_level: "Bogus",
		});
		expect(restored?.sensitivity_level).toBe("Public");
	});

	it("includes schema_version in the snapshot envelope", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const snap = writer.serialize("rtt-session");
		expect(snap?.schema_version).toBe(1);
	});

	it("refuses snapshots from a newer schema version", () => {
		const reader = new SessionTracker();
		const restored = reader.hydrate({
			schema_version: 999,
			session_id: "future-session",
			tool_call_count: 5,
		});
		expect(restored).toBeNull();
		expect(reader.get("future-session")).toBeUndefined();
	});

	it("preserves assertion_counts across serialize/hydrate (Plan 09 Phase 1)", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		if (session) {
			session.assertion_counts.set("src/foo.test.ts", { blocks: 3, assertions: 5 });
			session.assertion_counts.set("src/bar.test.ts", { blocks: 1, assertions: 1 });
		}

		const snap = writer.serialize("rtt-session");
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));

		expect(restored?.assertion_counts.size).toBe(2);
		expect(restored?.assertion_counts.get("src/foo.test.ts")).toEqual({
			blocks: 3,
			assertions: 5,
		});
		expect(restored?.assertion_counts.get("src/bar.test.ts")).toEqual({
			blocks: 1,
			assertions: 1,
		});
	});

	it("hydrates missing assertion_counts to an empty Map (older snapshot)", () => {
		// Defensive: a snapshot from before this field landed should not crash
		// `checkAssertionDensity`'s `session.assertion_counts.get(...)` lookup.
		const reader = new SessionTracker();
		const restored = reader.hydrate({
			session_id: "old-session",
			// no assertion_counts field
		});
		expect(restored?.assertion_counts).toBeInstanceOf(Map);
		expect(restored?.assertion_counts.size).toBe(0);
	});

	it("preserves observed_checks (incl. optional *_at / detail) across serialize/hydrate (#16)", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		if (session) {
			session.observed_checks = new Map([
				["typecheck", { kind: "typecheck", status: "red", red_at: 4, detail: "tsc --noEmit" }],
				["lint", { kind: "lint", status: "green", green_at: 9, red_at: 2 }],
			]);
		}

		const snap = writer.serialize("rtt-session");
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));

		expect(restored?.observed_checks?.size).toBe(2);
		expect(restored?.observed_checks?.get("typecheck")).toEqual({
			kind: "typecheck",
			status: "red",
			red_at: 4,
			detail: "tsc --noEmit",
		});
		expect(restored?.observed_checks?.get("lint")).toEqual({
			kind: "lint",
			status: "green",
			green_at: 9,
			red_at: 2,
		});
	});

	it("hydrates missing observed_checks to an empty Map and drops malformed entries (#16)", () => {
		const reader = new SessionTracker();
		// Older snapshot: no observed_checks at all.
		const old = reader.hydrate({ session_id: "old-obs" });
		expect(old?.observed_checks).toBeInstanceOf(Map);
		expect(old?.observed_checks?.size).toBe(0);

		// Malformed entries (unknown kind / status, non-object) are dropped;
		// only the valid one survives.
		const mixed = reader.hydrate({
			session_id: "mixed-obs",
			observed_checks: {
				typecheck: { kind: "typecheck", status: "red", red_at: 1 },
				bogusKind: { kind: "coverage", status: "red" },
				bogusStatus: { kind: "lint", status: "yellow" },
				notAnObject: 42,
			},
		});
		expect(mixed?.observed_checks?.size).toBe(1);
		expect(mixed?.observed_checks?.get("typecheck")?.status).toBe("red");
	});

	it("returns null when serializing an unknown session id", () => {
		const writer = new SessionTracker();
		expect(writer.serialize("does-not-exist")).toBeNull();
	});

	it("hydrates a malformed (non-null, non-number) step_limit to Infinity", () => {
		const reader = new SessionTracker();
		const restored = reader.hydrate({
			session_id: "weird-step-limit",
			step_limit: "unlimited", // not null, not a finite number
		});
		expect(restored?.step_limit).toBe(Number.POSITIVE_INFINITY);
	});

	it("serializes real active_skills entries, then falls back to {} once hydrate leaves it unset", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		if (session) recordSkillEnter(session, { name: "interlinked-verify", ttl_seconds: 600 });

		const snap = writer.serialize("rtt-session");
		const activeSkills = parseWire(snap?.active_skills, wireRecord(wireObject({ "name": wireString })), "test JSON value");
		expect(activeSkills["interlinked-verify"]?.name).toBe("interlinked-verify");

		// A snapshot that never recorded a skill hydrates active_skills to
		// undefined (readActiveSkills' empty-map contract) — re-serializing
		// THAT session must fall back to the empty-object branch, not throw.
		const reader = new SessionTracker();
		const bare = reader.hydrate({ session_id: "no-skills" });
		expect(bare?.active_skills).toBeUndefined();
		const reSnap = reader.serialize("no-skills");
		expect(reSnap?.active_skills).toEqual({});
	});

	it("serializes git_session_baseline as null once hydrate leaves it unset", () => {
		const reader = new SessionTracker();
		// No git_session_baseline field at all — readGitSessionBaseline returns
		// undefined, unlike a freshly-created session (which always captures one).
		const restored = reader.hydrate({ session_id: "no-git-baseline" });
		expect(restored?.git_session_baseline).toBeUndefined();
		const snap = reader.serialize("no-git-baseline");
		expect(snap?.git_session_baseline).toBeNull();
	});

	it("serializes real content for failed_files, warnings_issued, tdd_cycles, test_runs, stubs_introduced", () => {
		const writer = new SessionTracker();
		writer.recordEvent(baseEvent({}));
		const session = writer.get("rtt-session");
		if (session) {
			session.failed_files.set("src/broken.ts", {
				failure_count: 2,
				checks: ["typescript"],
				recorded_at: "2026-05-05T10:00:00Z",
				tool_call_count: 1,
			});
			session.warnings_issued.set("src/broken.ts::typescript", {
				check_name: "typescript",
				issue_count: 2,
				first_issued_at: 1,
				last_issued_at: 2,
				resolved: false,
			});
			session.tdd_cycles.set("src/foo.ts", {
				source_file: "src/foo.ts",
				test_file: "src/foo.test.ts",
				state: "red",
				impl_edits_before_test: 0,
			});
			session.test_runs.set("src/foo.test.ts", { status: "fail", at_step: 3 });
			session.stubs_introduced = [{ file: "src/foo.ts", kind: "TODO", snippet: "// TODO: fix" }];
		}

		const snap = writer.serialize("rtt-session");

		const failedFiles = parseWire(snap?.failed_files, wireRecord(wireObject({ "failure_count": wireNumber })), "test JSON value");
		expect(failedFiles["src/broken.ts"]?.failure_count).toBe(2);

		const warningsIssued = parseWire(snap?.warnings_issued, wireRecord(wireObject({ "issue_count": wireNumber })), "test JSON value");
		expect(warningsIssued["src/broken.ts::typescript"]?.issue_count).toBe(2);

		const tddCycles = parseWire(snap?.tdd_cycles, wireRecord(wireObject({ "state": wireString })), "test JSON value");
		expect(tddCycles["src/foo.ts"]?.state).toBe("red");

		const testRuns = parseWire(snap?.test_runs, wireRecord(wireObject({ "status": wireString })), "test JSON value");
		expect(testRuns["src/foo.test.ts"]?.status).toBe("fail");

		const stubsIntroduced = parseWire(snap?.stubs_introduced, wireArray(wireObject({ "kind": wireString })), "test JSON value");
		expect(stubsIntroduced).toHaveLength(1);
		expect(stubsIntroduced[0]?.kind).toBe("TODO");

		// Round-trip: the hydrated copy must carry the same content forward.
		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));
		expect(restored?.failed_files.get("src/broken.ts")?.failure_count).toBe(2);
		expect(restored?.tdd_cycles.get("src/foo.ts")?.state).toBe("red");
		expect(restored?.test_runs.get("src/foo.test.ts")?.status).toBe("fail");
		expect(restored?.stubs_introduced).toHaveLength(1);
	});
});
