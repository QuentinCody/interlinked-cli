// U3b (2026-10-08): the whole-workspace snapshot diff charged a sibling's
// write to whichever call reconciled next. consumeWorkspaceSnapshot now labels
// each effect (rule: touch-attribution.ts) and keeps shadows out of the
// caller's ownership records.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeFileRecords } from "./data-capture-native.js";
import { resetTouchAttribution } from "./touch-attribution.js";
import type { HarnessEvent } from "./types.js";
import { partitionResidueByAttribution, resetReconciledEffectRegistry } from "./workspace-effect-attribution.js";
import {
	clearWorkspaceEffectSession,
	consumeWorkspaceSnapshot,
	rememberWorkspaceSnapshot,
} from "./workspace-effects.js";

let root: string;

beforeEach(() => {
	resetReconciledEffectRegistry();
	resetTouchAttribution();
	root = mkdtempSync(join(tmpdir(), "interlinked-shadow-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, "tracked.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "tracked.ts"], { cwd: root });
});

afterEach(() => {
	clearWorkspaceEffectSession("shared");
	rmSync(root, { recursive: true, force: true });
});

const bash = { toolName: "Bash", declaredTargets: [] };

describe("workspace effect shadow attribution — positive (must fire)", () => {
	it("P1: a sibling's Edit that reconciles first makes the same change a shadow in my Bash diff", () => {
		rememberWorkspaceSnapshot({ toolUseId: "mine", sessionId: "shared", subagentId: "me", root });
		rememberWorkspaceSnapshot({ toolUseId: "theirs", sessionId: "shared", subagentId: "sib", declaredTargets: ["tracked.ts"], root });
		writeFileSync(join(root, "tracked.ts"), "export const value = 2;\n");
		const theirs = consumeWorkspaceSnapshot({ toolUseId: "theirs", sessionId: "shared", subagentId: "sib", root, call: { toolName: "Edit", declaredTargets: ["tracked.ts"] } });
		expect(theirs?.files[0]).toMatchObject({ path: "tracked.ts", attribution: "declared-target" });
		const mine = consumeWorkspaceSnapshot({ toolUseId: "mine", sessionId: "shared", subagentId: "me", root, call: bash });
		expect(mine?.files[0]).toMatchObject({ path: "tracked.ts", attribution: "shadow", shadow_reason: "attributed-to-other-actor" });
	});
	it("P2: a sibling's still-in-flight Edit target is a shadow in my Bash diff even when I reconcile first", () => {
		rememberWorkspaceSnapshot({ toolUseId: "mine", sessionId: "shared", subagentId: "me", root });
		rememberWorkspaceSnapshot({ toolUseId: "theirs", sessionId: "shared", subagentId: "sib", declaredTargets: [join(root, "tracked.ts")], root });
		writeFileSync(join(root, "tracked.ts"), "export const value = 3;\n");
		const mine = consumeWorkspaceSnapshot({ toolUseId: "mine", sessionId: "shared", subagentId: "me", root, call: bash });
		expect(mine?.files[0]).toMatchObject({ attribution: "shadow", shadow_reason: "in-flight-target-of-other-actor" });
	});
	it("P3: the files-touched row for a shadow says shadow: true and keeps the change data", () => {
		rememberWorkspaceSnapshot({ toolUseId: "edit", sessionId: "shared", subagentId: "me", root });
		writeFileSync(join(root, "other.ts"), "x\n");
		const changeSet = consumeWorkspaceSnapshot({ toolUseId: "edit", sessionId: "shared", subagentId: "me", root, call: { toolName: "Edit", declaredTargets: ["tracked.ts"] } });
		const event: HarnessEvent = { hook_event: "PostToolUse", session_id: "shared", agent_source: "claude", timestamp: "t", tool_name: "Edit", ...(changeSet ? { change_set: changeSet } : {}) };
		expect(nativeFileRecords(event)[0]).toMatchObject({ file: "other.ts", kind: "created", shadow: true, shadow_reason: "not-declared-target" });
	});
});

describe("workspace effect shadow attribution — negative (must not fire)", () => {
	it("N1: my own Bash-created file is attributed, and the row says shadow: false", () => {
		rememberWorkspaceSnapshot({ toolUseId: "mine", sessionId: "shared", subagentId: "me", root });
		writeFileSync(join(root, "generated.ts"), "export {};\n");
		const changeSet = consumeWorkspaceSnapshot({ toolUseId: "mine", sessionId: "shared", subagentId: "me", root, call: bash });
		expect(changeSet?.files[0]).toMatchObject({ path: "generated.ts", attribution: "observed-in-window" });
		const event: HarnessEvent = { hook_event: "PostToolUse", session_id: "shared", agent_source: "claude", timestamp: "t", tool_name: "Bash", ...(changeSet ? { change_set: changeSet } : {}) };
		expect(nativeFileRecords(event)[0]).toMatchObject({ shadow: false });
	});
	it("N2: a shadow does not take ownership away from the real writer's residue record", () => {
		rememberWorkspaceSnapshot({ toolUseId: "edit", sessionId: "shared", subagentId: "me", root });
		writeFileSync(join(root, "peer.ts"), "peer\n");
		const changeSet = consumeWorkspaceSnapshot({ toolUseId: "edit", sessionId: "shared", subagentId: "me", root, call: { toolName: "Edit", declaredTargets: ["tracked.ts"] } });
		const peer = changeSet?.files.find((effect) => effect.path === "peer.ts");
		expect(peer?.attribution).toBe("shadow");
		// Before U3b the shadow was recorded as "me", so the ROOT actor's residue
		// read peer.ts as another actor's reconciled work (1). Now nobody owns it.
		expect(partitionResidueByAttribution("shared", peer ? [peer] : [], undefined).attributedElsewhere).toBe(0);
	});
	it("N3: a caller that passes no call identity gets the legacy unlabeled ChangeSet", () => {
		rememberWorkspaceSnapshot({ toolUseId: "legacy", sessionId: "shared", root });
		writeFileSync(join(root, "legacy.ts"), "x\n");
		const changeSet = consumeWorkspaceSnapshot({ toolUseId: "legacy", sessionId: "shared", root });
		expect(changeSet?.files[0]).not.toHaveProperty("attribution");
	});
});
