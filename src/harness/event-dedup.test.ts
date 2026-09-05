import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetDedupForTesting, dedupKey, recordDeliveryForShadow } from "./event-dedup.js";
import type { HarnessEvent } from "./types.js";

let sandboxRoot: string;
beforeEach(() => { sandboxRoot = mkdtempSync(join(tmpdir(), "dedup-shadow-")); });
afterEach(() => { rmSync(sandboxRoot, { recursive: true, force: true }); });

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
});
