import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetDedupForTesting, dedupKey, recordDeliveryForShadow } from "./event-dedup.js";
import type { HarnessEvent } from "./types.js";

/** Overridden only by the one test forcing appendFileSync to fail (a
 *  telemetry/IO error); every other test gets the real filesystem, so the
 *  redundant-delivery tests still exercise the genuine dedup-shadow.jsonl
 *  write path. */
let appendFileSyncOverride: (() => void) | null = null;
let sandboxRoot: string;
beforeEach(() => { sandboxRoot = mkdtempSync(join(tmpdir(), "dedup-shadow-")); });
afterEach(() => { rmSync(sandboxRoot, { recursive: true, force: true }); });

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			if (appendFileSyncOverride) return appendFileSyncOverride();
			return actual.appendFileSync(...args);
		},
	};
});

/** Minimal HarnessEvent for de-dup tests — only the fields the module reads. */
function ev(p: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: "/a.ts" },
		timestamp: "2026-05-17T00:00:00Z",
		cwd: sandboxRoot,
		...p,
	} as unknown as HarnessEvent;
}

describe("dedupKey", () => {
	it("uses tool_use_id when the event carries one", () => {
		const k = dedupKey(ev({ tool_use_id: "toolu_abc" }));
		expect(k.kind).toBe("tool_use_id");
		expect(k.key).toContain("toolu_abc");
	});

	it("falls back to a composite key when tool_use_id is absent", () => {
		expect(dedupKey(ev({ tool_use_id: undefined })).kind).toBe("composite");
	});

	it("gives a call's PreToolUse and PostToolUse distinct keys", () => {
		const pre = dedupKey(ev({ tool_use_id: "toolu_x", hook_event: "PreToolUse" }));
		const post = dedupKey(ev({ tool_use_id: "toolu_x", hook_event: "PostToolUse" }));
		expect(pre.key).not.toBe(post.key);
	});

	it("gives genuinely distinct tool calls distinct keys", () => {
		expect(dedupKey(ev({ tool_use_id: "toolu_1" })).key).not.toBe(
			dedupKey(ev({ tool_use_id: "toolu_2" })).key,
		);
	});
});

describe("recordDeliveryForShadow", () => {
	beforeEach(() => {
		appendFileSyncOverride = null;
	});

	beforeEach(() => {
		__resetDedupForTesting();
	});

	it("marks the first delivery of a call as not a duplicate", () => {
		const o = recordDeliveryForShadow(ev({ tool_use_id: "toolu_a" }));
		expect(o.isDuplicate).toBe(false);
		expect(o.deliveryIndex).toBe(1);
	});

	it("marks redundant deliveries of the same call as duplicates, counting them", () => {
		const e = ev({ tool_use_id: "toolu_a" });
		recordDeliveryForShadow(e);
		const second = recordDeliveryForShadow(e);
		const third = recordDeliveryForShadow(e);
		expect(second.isDuplicate).toBe(true);
		expect(second.deliveryIndex).toBe(2);
		expect(third.deliveryIndex).toBe(3);
	});

	it("does NOT treat two genuinely distinct calls as duplicates", () => {
		const a = recordDeliveryForShadow(ev({ tool_use_id: "toolu_1" }));
		const b = recordDeliveryForShadow(ev({ tool_use_id: "toolu_2" }));
		expect(a.isDuplicate).toBe(false);
		expect(b.isDuplicate).toBe(false);
	});

	it("does NOT dedup a PostToolUse delivery against the call's PreToolUse", () => {
		recordDeliveryForShadow(ev({ tool_use_id: "toolu_p", hook_event: "PreToolUse" }));
		const post = recordDeliveryForShadow(ev({ tool_use_id: "toolu_p", hook_event: "PostToolUse" }));
		expect(post.isDuplicate).toBe(false);
	});

	it("dedups via the composite key when tool_use_id is absent", () => {
		const e = ev({ tool_use_id: undefined, tool_input: { file_path: "/x.ts" } });
		expect(recordDeliveryForShadow(e).isDuplicate).toBe(false);
		const dup = recordDeliveryForShadow(e);
		expect(dup.isDuplicate).toBe(true);
		expect(dup.kind).toBe("composite");
	});

	it("does NOT dedup composite-key events that differ in tool_input", () => {
		recordDeliveryForShadow(ev({ tool_use_id: undefined, tool_input: { file_path: "/x.ts" } }));
		const other = recordDeliveryForShadow(
			ev({ tool_use_id: undefined, tool_input: { file_path: "/y.ts" } }),
		);
		expect(other.isDuplicate).toBe(false);
	});

	it("__resetDedupForTesting clears the window", () => {
		const e = ev({ tool_use_id: "toolu_r" });
		recordDeliveryForShadow(e);
		__resetDedupForTesting();
		expect(recordDeliveryForShadow(e).isDuplicate).toBe(false);
	});

	it("falls back to a fixed composite key for a circular tool_input that JSON.stringify can't serialize", () => {
		// A plain object's default toString() is always the literal string
		// "[object Object]" — the circular reference makes JSON.stringify throw,
		// so hashToolInput falls back to String(input) and loses the object's
		// shape entirely. The djb2 hash of that literal fallback string is a
		// fixed, precomputable value: "27597cab".
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		const k = dedupKey(ev({ tool_use_id: undefined, tool_input: circular }));
		expect(k.key).toBe("cmp:PostToolUse:sess-1|Edit|27597cab");
	});

	it("evicts the oldest tracked key once the map exceeds MAX_TRACKED_KEYS entries", () => {
		const firstEvent = ev({ tool_use_id: "toolu-oldest" });
		recordDeliveryForShadow(firstEvent);
		// MAX_TRACKED_KEYS is 2_000; push well past it with fresh keys so the
		// overflow-eviction branch (not the 5s time-window branch) fires and
		// definitely reaches back to the very first inserted key.
		for (let i = 0; i < 2_500; i++) {
			recordDeliveryForShadow(ev({ tool_use_id: `toolu-fresh-${i}` }));
		}
		// If the oldest key were still tracked, replaying it would read as a
		// duplicate; eviction makes this delivery look brand new again.
		expect(recordDeliveryForShadow(firstEvent).isDuplicate).toBe(false);
	});

	it("fails open (not a duplicate) when writing the shadow record throws", () => {
		appendFileSyncOverride = () => {
			throw new Error("ENOSPC: no space left on device");
		};
		const e = ev({ tool_use_id: "toolu-io-fail" });
		recordDeliveryForShadow(e); // first delivery — establishes `prior`
		const result = recordDeliveryForShadow(e); // duplicate -> appendShadowRecord throws
		expect(result).toEqual({ isDuplicate: false, deliveryIndex: 1, kind: "composite" });
	});
});
