// ===========================================================================
// Mutation-kill residue pass (W6) for src/harness/legacy-client.ts.
//
// Targets the 59 `survived` mutants recorded for this file in
// .interlinked/mutation-manifest.json as of 2026-08-17. The sibling
// `legacy-client.test.ts` already covers the module's documented behavior;
// every case below pins an OBSERVABLE distinction that suite's assertions
// happen to let through — mostly because `toEqual` does not distinguish an
// object key set to `undefined` from an absent key (Vitest/Jest semantics),
// or because an existing `it.each` table never chose inputs where two code
// paths' outputs actually diverge.
//
// Five survivors are NOT re-tested here — see the receipts file
// (scratch/fleet-r3/receipts/legacy-client.jsonl) for the structural
// equivalence argument for each: f79ab0b5a7da14b9, fe8a9cf0339a4dfd,
// 3919252a1c662375, 564e8fb5d364c691, 49f7b42967fe8c82.
// ===========================================================================

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision } from "./types.js";
import type { UnifiedAction, UnifiedHookEvent } from "./unified-event.js";

// ---------------------------------------------------------------------------
// Deterministic fake `node:net` socket — same shape as legacy-client.test.ts.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
	public written: string[] = [];
	public destroyed = false;
	write(chunk: string): boolean {
		this.written.push(chunk);
		return true;
	}
	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

let lastSocket: FakeSocket | null = null;
const createConnectionMock = vi.fn(
	(_path: string, onConnect?: () => void): FakeSocket => {
		const sock = new FakeSocket();
		lastSocket = sock;
		// Real node:net invokes the connect listener asynchronously, after the
		// caller's `socket = createConnection(...)` local has been assigned.
		if (onConnect) queueMicrotask(onConnect);
		return sock;
	},
);

vi.mock("node:net", () => ({
	createConnection: (path: string, onConnect?: () => void) =>
		createConnectionMock(path, onConnect),
}));

// Import under test AFTER the mock is registered.
import { callLegacyHarness, toLegacyHarnessEvent } from "./legacy-client.js";

beforeEach(() => {
	vi.useFakeTimers();
	lastSocket = null;
	createConnectionMock.mockClear();
});

afterEach(() => {
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Event builders — mirrors legacy-client.test.ts's makeEvent/makePreEditEvent.
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	const base: UnifiedHookEvent = {
		schema_version: "1",
		event_id: "evt-1",
		session_id: "s1",
		ts: "2026-05-05T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: {
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			tool_input_redacted: { file_path: "src/a.ts" },
		},
		context: { cwd: "/repo", agent: { id: "agent-a" } },
		raw: {},
	};
	return { ...base, ...overrides };
}

function makePreEditEvent(): UnifiedHookEvent {
	return makeEvent({
		raw: {
			session_id: "s1",
			cwd: "/repo",
			tool_name: "Edit",
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			tool_use_id: "tool-1",
		},
	});
}

// ===========================================================================
// parseResolvedTarget — non-object / wrong-typed entries, every kind member
// ===========================================================================

describe("parseResolvedTarget — non-object and wrong-typed entries", () => {
	// test-contract: boundary — a null entry in resolved_targets must be
	// dropped by the isJsonObject guard rather than reaching `value.kind`.
	it("P: drops a null entry in resolved_targets instead of throwing", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					decision: "ask",
					resolved_targets: [{ kind: "file", value: "a.ts" }, null],
				})}\n`,
			),
		);
		const resolved = await promise;
		expect(resolved.resolved_targets).toEqual([{ kind: "file", value: "a.ts" }]);
	});

	// test-contract: boundary — a recognized kind whose value is not a string
	// must be dropped entirely, not kept with the non-string value attached.
	it("N: drops a resolved_targets entry whose value is not a string", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					decision: "ask",
					resolved_targets: [{ kind: "file", value: 42 }],
				})}\n`,
			),
		);
		const resolved = await promise;
		expect(resolved.resolved_targets).toEqual([]);
	});

	// test-contract: public-api — every member of RESOLVED_TARGET_KINDS (the
	// existing suite only ever exercises "file") must individually round-trip.
	it.each(["table", "url", "branch", "recipient", "package"] as const)(
		"P: kind %s round-trips through resolved_targets",
		async (kind) => {
			const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
				timeout_ms: 250,
			});
			const socket = lastSocket as FakeSocket;
			socket.emit(
				"data",
				Buffer.from(
					`${JSON.stringify({
						decision: "ask",
						resolved_targets: [{ kind, value: "v-1" }],
					})}\n`,
				),
			);
			const resolved = await promise;
			expect(resolved.resolved_targets).toEqual([{ kind, value: "v-1" }]);
		},
	);
});

// ===========================================================================
// parseHarnessDecision — undefined-valued optional keys must be absent
// ===========================================================================

describe("parseHarnessDecision — omitted optionals stay absent, not undefined-valued", () => {
	// test-contract: public-api — callers do `"reason" in decision` / spread
	// the result; a key present with value `undefined` is observably
	// different from an absent key. `toStrictEqual` (unlike `toEqual`) checks
	// this, so this is the exact-observable form of the existing N5 case.
	it("P: a minimal {decision} wire payload has exactly one key, no undefined-valued optionals", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit("data", Buffer.from(`${JSON.stringify({ decision: "allow" })}\n`));
		const resolved = await promise;
		expect(resolved).toStrictEqual({ decision: "allow" });
	});

	// test-contract: boundary — a non-object top-level line (JSON `null`) must
	// reject with the explicit "malformed" error, not crash trying to
	// destructure `decision` off a value the isJsonObject guard should have
	// already excluded.
	it("P: a top-level JSON null line rejects as malformed, not with a destructuring crash", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit("data", Buffer.from("null\n"));
		await expect(promise).rejects.toThrow("malformed legacy harness decision");
	});

	// test-contract: boundary — reason/rule_id/additional_context are each
	// gated by their own independent typeof check; a wrong-typed value on one
	// field must not leak it into the parsed decision.
	it("N: drops reason/rule_id/additional_context when present but not string-typed", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ decision: "allow", reason: 1, rule_id: 2, additional_context: 3 })}\n`,
			),
		);
		const resolved = await promise;
		expect(resolved).toStrictEqual({ decision: "allow" });
	});
});

// ===========================================================================
// callLegacyHarness — finish() idempotency (the settled-guard internals)
// ===========================================================================

describe("callLegacyHarness — finish() idempotency", () => {
	// test-contract: invariant — finish() is meant to be a true one-shot: once
	// its body (destroy + fn()) has run for a settled promise, a later
	// trigger (e.g. a late socket error) must not re-run that body.
	it("P: a late socket error after resolution does not re-destroy the socket", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		const destroySpy = vi.spyOn(socket, "destroy");
		try {
			const decision: HarnessDecision = { decision: "allow" };
			socket.emit("data", Buffer.from(`${JSON.stringify(decision)}\n`));
			await expect(promise).resolves.toEqual(decision);
			expect(destroySpy).toHaveBeenCalledTimes(1);
			socket.emit("error", new Error("late, after resolution"));
			expect(destroySpy).toHaveBeenCalledTimes(1);
			await expect(promise).resolves.toEqual(decision);
		} finally {
			destroySpy.mockRestore();
		}
	});

	// test-contract: boundary — createConnection can throw synchronously
	// before the `socket` local is ever assigned; the timeout timer (already
	// scheduled earlier in the executor) still fires later and must not
	// crash trying to destroy a socket that was never set.
	it("P: a synchronous createConnection throw leaves the later timeout tick a no-op", async () => {
		createConnectionMock.mockImplementationOnce(() => {
			throw new Error("sync-connect-failure");
		});
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 25,
		});
		await expect(promise).rejects.toThrow("sync-connect-failure");
		expect(() => vi.advanceTimersByTime(25)).not.toThrow();
	});
});

// ===========================================================================
// copyDeliveryId — event.event_id -> out.event_id
// ===========================================================================

describe("copyDeliveryId", () => {
	// test-contract: public-api — a non-empty event_id must be copied
	// verbatim onto the legacy event.
	it("P: copies a non-empty event_id onto the legacy event", () => {
		const legacy = toLegacyHarnessEvent(makeEvent({ event_id: "evt-77" }));
		expect(legacy.event_id).toBe("evt-77");
	});

	// test-contract: boundary — an empty-string event_id is falsy; the key
	// must be omitted entirely, not set to "".
	it("N: omits event_id when it is an empty string", () => {
		const legacy = toLegacyHarnessEvent(makeEvent({ event_id: "" }));
		expect("event_id" in legacy).toBe(false);
	});
});

// ===========================================================================
// applyActionFields — tool_response presence, session_lifecycle fall-through
// ===========================================================================

describe("applyActionFields", () => {
	// test-contract: boundary — no tool_response on the action must leave the
	// key absent on the legacy event, not present with value undefined.
	it("N: tool_call omits tool_response entirely when the action carries none", () => {
		const action: UnifiedAction = {
			kind: "tool_call",
			tool_name: "read",
			tool_class: "read",
			tool_input: {},
			tool_input_redacted: {},
		};
		const legacy = toLegacyHarnessEvent(makeEvent({ action, raw: {} }));
		expect("tool_response" in legacy).toBe(false);
	});

	// test-contract: invariant — session_lifecycle must `break`, not fall
	// through into the "other" case's lifecycle-scalar scraping, even when
	// raw happens to carry keys "other" would otherwise pick up.
	it("N: session_lifecycle sets no tool_input even when raw carries lifecycle scalars", () => {
		const legacy = toLegacyHarnessEvent(
			makeEvent({
				phase: "session-end",
				runner_native_event: "SessionEnd",
				action: { kind: "session_lifecycle", event: "end" },
				raw: { task_id: "t1", task_subject: "s" },
			}),
		);
		expect("tool_input" in legacy).toBe(false);
	});
});

// ===========================================================================
// applyLegacyFieldFallbacks — raw fallbacks must not override action values
// ===========================================================================

describe("applyLegacyFieldFallbacks", () => {
	// test-contract: invariant — the raw.tool_input fallback is gated by
	// `out.tool_input === undefined`; it must never overwrite a value the
	// action already produced.
	it("P: a raw.tool_input fallback does not override tool_input already set by the action", () => {
		const ev = makeEvent({
			action: { kind: "shell_command", command: "echo hi", tool_class: "side-effect" },
			raw: { tool_input: { file_path: "should-not-appear" } },
		});
		expect(toLegacyHarnessEvent(ev).tool_input).toEqual({ command: "echo hi" });
	});

	// test-contract: boundary — with no tool_response anywhere (neither the
	// action nor raw's snake/camel keys), the key must be absent, not set to
	// undefined by either fallback arm.
	it("N: omits tool_response entirely when neither the action nor raw provides one", () => {
		const ev = makeEvent({
			action: { kind: "user_prompt", text: "hi" },
			phase: "user-prompt",
			runner_native_event: "UserPromptSubmit",
			raw: {},
		});
		expect("tool_response" in toLegacyHarnessEvent(ev)).toBe(false);
	});
});

// ===========================================================================
// legacyHookEventName — every LEGACY_NATIVE_EVENTS member wins over phase
// ===========================================================================

describe("legacyHookEventName — each native legacy event is individually recognized", () => {
	// test-contract: public-api — a recognized native event name must be
	// returned verbatim even when `phase` maps to a DIFFERENT legacy name.
	// The existing suite's native-event test paired "PreCompact" with
	// phase "other" (which itself falls through to `native`), so removing
	// any one member from LEGACY_NATIVE_EVENTS — or emptying the whole set —
	// was unobservable there. Pairing each native name with a phase whose
	// OWN mapping differs from it makes recognition load-bearing.
	it.each([
		["PreToolUse", "post-tool"],
		["PostToolUse", "pre-tool"],
		["PostToolUseFailure", "pre-tool"],
		["SessionStart", "pre-tool"],
		["SessionEnd", "pre-tool"],
		["UserPromptSubmit", "pre-tool"],
		["Stop", "pre-tool"],
		["SubagentStart", "pre-tool"],
		["SubagentStop", "pre-tool"],
		["Notification", "pre-tool"],
		["PreCompact", "pre-tool"],
		["TaskCompleted", "pre-tool"],
		["TeammateIdle", "pre-tool"],
		["PermissionRequest", "pre-tool"],
		["BeforeTool", "pre-tool"],
		["AfterTool", "pre-tool"],
		["AfterModel", "pre-tool"],
		["PreCompress", "pre-tool"],
	] as const)("native %s beats phase %s's own mapping", (native, phase) => {
		const ev = makeEvent({
			runner_native_event: native,
			phase,
			action: { kind: "other", subkind: "x", data: null },
			raw: {},
		});
		expect(toLegacyHarnessEvent(ev).hook_event).toBe(native);
	});
});

// ===========================================================================
// pickLifecycleScalars — typeof gate, not just truthiness
// ===========================================================================

describe("pickLifecycleScalars", () => {
	// test-contract: boundary — a non-string truthy scalar value (task_id as
	// a number) must be excluded; only string-typed AND non-empty counts.
	it("N: excludes a lifecycle scalar key whose value is a truthy non-string", () => {
		const ev = makeEvent({
			runner_native_event: "TaskCompleted",
			phase: "other",
			action: { kind: "other", subkind: "TaskCompleted", data: {} },
			raw: { task_id: 5 },
		});
		expect(toLegacyHarnessEvent(ev).tool_input).toBeUndefined();
	});

	// test-contract: boundary — an empty-string scalar value is string-typed
	// but falsy; the `&& value` half of the gate must still exclude it.
	it("N: excludes a lifecycle scalar key whose value is an empty string", () => {
		const ev = makeEvent({
			runner_native_event: "TaskCompleted",
			phase: "other",
			action: { kind: "other", subkind: "TaskCompleted", data: {} },
			raw: { task_id: "" },
		});
		expect(toLegacyHarnessEvent(ev).tool_input).toBeUndefined();
	});
});

// ===========================================================================
// copyTurnContext — prompt_id, effort-null safety, background_tasks gates
// ===========================================================================

describe("copyTurnContext", () => {
	// test-contract: boundary — no prompt_id anywhere means the key must be
	// absent, not set to null.
	it("N: omits prompt_id when raw.prompt_id is absent", () => {
		const ev = makeEvent({ raw: {} });
		expect("prompt_id" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	// test-contract: public-api — a non-empty string prompt_id must be
	// copied verbatim.
	it("P: copies prompt_id when raw.prompt_id is a non-empty string", () => {
		const ev = makeEvent({ raw: { prompt_id: "p-123" } });
		expect(toLegacyHarnessEvent(ev).prompt_id).toBe("p-123");
	});

	// test-contract: invariant — raw.effort === null must not crash trying to
	// read `.level` off it. typeof null === "object", so the object-shape
	// guard exists specifically to exclude null before that property read.
	it("P: raw.effort === null does not throw and leaves effort unset", () => {
		const ev = makeEvent({ raw: { effort: null } });
		expect(() => toLegacyHarnessEvent(ev)).not.toThrow();
		expect("effort" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	// test-contract: boundary — a non-array background_tasks value must be
	// dropped, not copied through.
	it("N: omits background_tasks when present but not an array", () => {
		const ev = makeEvent({ raw: { background_tasks: "not-an-array" } });
		expect("background_tasks" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	// test-contract: public-api — a real background_tasks array must be
	// copied verbatim (exact value, not just "truthy").
	it("P: copies background_tasks verbatim when it is an array", () => {
		const tasks = [{ id: "t1", type: "explore", status: "running" }];
		const ev = makeEvent({ raw: { background_tasks: tasks } });
		expect(toLegacyHarnessEvent(ev).background_tasks).toEqual(tasks);
	});
});
