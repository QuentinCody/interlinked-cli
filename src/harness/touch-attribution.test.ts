import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attributeWorkspaceEffects,
	declaredTouchTargets,
	recordAttributedTouches,
	resetTouchAttribution,
	TOUCH_DEDUPE_WINDOW_MS,
	touchActorKey,
} from "./touch-attribution.js";
import type { HarnessEvent } from "./types.js";

let root: string;
// ctime is always the real clock (utimes cannot set it), so the window is too.
const NOW = Date.now();
const BEFORE = new Date(NOW - 5_000).toISOString();
const me = touchActorKey("s1", "sub-me");
const sibling = touchActorKey("s1", "sub-sibling");

function effect(path: string, before: string | null = "b0", after: string | null = "a1") {
	return { path, kind: (before === null ? "created" : after === null ? "deleted" : "modified") as "created" | "modified" | "deleted", before_sha256: before, after_sha256: after };
}

function touch(path: string, atMs: number): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), "x");
	utimesSync(join(root, path), atMs / 1000, atMs / 1000);
}

function base(toolName: string, declaredTargets: string[] = []) {
	return { root, actorKey: me, toolName, declaredTargets, beforeCapturedAt: BEFORE, inFlightTargetsOfOthers: new Set<string>(), nowMs: NOW };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "touch-attr-"));
	resetTouchAttribution();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("attributeWorkspaceEffects — positive (must fire: row is a shadow)", () => {
	it("P1: an Edit's effect on a path it did not target is a shadow", () => {
		const [row] = attributeWorkspaceEffects({ ...base("Edit", ["src/a.ts"]), effects: [effect("src/b.ts")] });
		expect(row).toMatchObject({ attribution: "shadow", shadow_reason: "not-declared-target" });
	});
	it("P2: a Bash effect already attributed to another actor with the same before/after within 10 min is a shadow", () => {
		recordAttributedTouches(sibling, [{ ...effect("src/a.ts"), attribution: "declared-target" }], NOW - 60_000);
		touch("src/a.ts", NOW - 500);
		const [row] = attributeWorkspaceEffects({ ...base("Bash"), effects: [effect("src/a.ts")] });
		expect(row).toMatchObject({ attribution: "shadow", shadow_reason: "attributed-to-other-actor" });
	});
	it("P3: a Bash effect whose mtime/ctime predates the call window is a shadow", () => {
		touch("old.ts", NOW - 120_000);
		// The call window opens after the file's last change (mtime and ctime).
		const rows = attributeWorkspaceEffects({
			...base("Bash"), beforeCapturedAt: new Date(Date.now() + 60_000).toISOString(), effects: [effect("old.ts")],
		});
		expect(rows[0]).toMatchObject({ attribution: "shadow", shadow_reason: "changed-before-call" });
	});
	it("P4: a Bash effect on another actor's in-flight declared target is a shadow", () => {
		touch("src/a.ts", NOW - 500);
		const rows = attributeWorkspaceEffects({ ...base("Bash"), inFlightTargetsOfOthers: new Set(["src/a.ts"]), effects: [effect("src/a.ts")] });
		expect(rows[0]).toMatchObject({ attribution: "shadow", shadow_reason: "in-flight-target-of-other-actor" });
	});
	it("P5: every effect seen during a read-only tool call is a shadow", () => {
		const rows = attributeWorkspaceEffects({ ...base("Grep"), effects: [effect("src/a.ts")] });
		expect(rows[0]).toMatchObject({ attribution: "shadow", shadow_reason: "read-only-tool" });
	});
});

describe("attributeWorkspaceEffects — negative (must not fire: row is attributed)", () => {
	it("N1: an Edit's effect on its own declared target is attributed, absolute or relative", () => {
		const rows = attributeWorkspaceEffects({ ...base("Edit", [join(root, "src/a.ts")]), effects: [effect("src/a.ts")] });
		expect(rows[0]).toMatchObject({ attribution: "declared-target" });
		expect(rows[0]).not.toHaveProperty("shadow_reason");
	});
	it("N2: a Bash effect changed inside the window and claimed by nobody else is attributed", () => {
		touch("gen.ts", NOW - 200);
		const rows = attributeWorkspaceEffects({ ...base("Bash"), effects: [effect("gen.ts")] });
		expect(rows[0]).toMatchObject({ attribution: "observed-in-window" });
	});
	it("N3: the same change attributed to the SAME actor is not a shadow", () => {
		recordAttributedTouches(me, [{ ...effect("x.ts"), attribution: "declared-target" }], NOW - 1_000);
		touch("x.ts", NOW - 200);
		expect(attributeWorkspaceEffects({ ...base("Bash"), effects: [effect("x.ts")] })[0]?.attribution).toBe("observed-in-window");
	});
	it("N4: another actor's identical change older than 10 minutes no longer shadows", () => {
		recordAttributedTouches(sibling, [{ ...effect("x.ts"), attribution: "declared-target" }], NOW - TOUCH_DEDUPE_WINDOW_MS - 1);
		touch("x.ts", NOW - 200);
		expect(attributeWorkspaceEffects({ ...base("Bash"), effects: [effect("x.ts")] })[0]?.attribution).toBe("observed-in-window");
	});
	it("N5: a different before/after pair on the same path does not shadow", () => {
		recordAttributedTouches(sibling, [{ ...effect("x.ts", "b0", "a1"), attribution: "declared-target" }], NOW - 1_000);
		touch("x.ts", NOW - 200);
		expect(attributeWorkspaceEffects({ ...base("Bash"), effects: [effect("x.ts", "a1", "a2")] })[0]?.attribution).toBe("observed-in-window");
	});
	it("N6: a shadow row is never recorded as an attribution (it cannot shadow a later caller)", () => {
		recordAttributedTouches(sibling, [{ ...effect("x.ts"), attribution: "shadow", shadow_reason: "not-declared-target" }], NOW - 1_000);
		touch("x.ts", NOW - 200);
		expect(attributeWorkspaceEffects({ ...base("Bash"), effects: [effect("x.ts")] })[0]?.attribution).toBe("observed-in-window");
	});
	it("N7: a direct-edit tool with no parseable target falls back to the window rule", () => {
		touch("nb.ts", NOW - 200);
		expect(attributeWorkspaceEffects({ ...base("Edit", []), effects: [effect("nb.ts")] })[0]?.attribution).toBe("observed-in-window");
	});
});

describe("declaredTouchTargets", () => {
	const ev = (tool_name: string, tool_input: HarnessEvent["tool_input"]): HarnessEvent => ({
		hook_event: "PostToolUse", session_id: "s1", agent_source: "claude", timestamp: "t", tool_name, tool_input,
	});
	it("P6: NotebookEdit's notebook_path and both sides of an apply_patch move are targets", () => {
		expect(declaredTouchTargets(ev("NotebookEdit", { notebook_path: join(root, "n.ipynb") }), root)).toEqual(["n.ipynb"]);
		const patch = "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n*** End Patch";
		expect(declaredTouchTargets(ev("apply_patch", { command: patch }), root).sort()).toEqual(["src/new.ts", "src/old.ts"]);
	});
	it("N8: a Bash command declares no targets (its effects go through the window rule)", () => {
		expect(declaredTouchTargets(ev("Bash", { command: "echo hi > a.ts" }), root)).toEqual([]);
	});
});
