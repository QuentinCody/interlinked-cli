import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBaselineIntegrityForEvent } from "./baseline-integrity-gate.js";
import { consumeBaselineSnapshot, rememberBaselineSnapshot } from "./baseline-effect-guard.js";
import type { HarnessEvent } from "../types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(enforced = false): string {
	const root = mkdtempSync(join(tmpdir(), "metric-policy-guards-"));
	roots.push(root); mkdirSync(join(root, ".interlinked"));
	if (enforced) writeFileSync(join(root, ".interlinked/config.json"), JSON.stringify({ harness: { edit_metrics: { mode: "enforced" } } }));
	return root;
}
const policy = (mode: string, threshold = 10) => JSON.stringify({ metrics: { cyclomatic: { mode, threshold } } });
function writeEvent(root: string, file: string, content: string): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "metric-integrity", agent_source: "codex", timestamp: "2026-11-11T00:00:00Z", cwd: root, tool_name: "Write", tool_input: { file_path: join(root, file), content } };
}

describe("metric policy normal guard entrypoints", () => {
	it("protects a per-metric entry that adopted inherited global blocking", () => {
		const root = project(true), config = ".interlinked/config.json";
		writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify({ metrics: { cyclomatic: { threshold: 10 } } }));
		expect(evaluateBaselineIntegrityForEvent(writeEvent(root, config, JSON.stringify({ harness: { edit_metrics: { mode: "advisory" } } })))?.decision).toBe("block");
	});
	it("preserves historical global policy editing when no metric entry was adopted", () => {
		const root = project(true);
		expect(evaluateBaselineIntegrityForEvent(writeEvent(root, ".interlinked/config.json", "{}"))).toBeNull();
	});
	it("restores global posture when its change weakens an adopted inherited metric", () => {
		const root = project(true), config = join(root, ".interlinked/config.json"), before = readFileSync(config, "utf8");
		writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify({ metrics: { cyclomatic: { scope: { paths: ["src/**"] } } } }));
		rememberBaselineSnapshot("metric-global", root);
		writeFileSync(config, "{}");
		expect(consumeBaselineSnapshot("metric-global", root)).toContain("RESTORED");
		expect(readFileSync(config, "utf8")).toBe(before);
	});
	it("blocks creation that turns inherited enforcement off", () => {
		const root = project(true);
		expect(evaluateBaselineIntegrityForEvent(writeEvent(root, ".interlinked/check-policy.json", policy("off")))?.rule_id).toBe("baseline_integrity_gate");
	});
	it("blocks removal of a preexisting adopted block", () => {
		const root = project();
		writeFileSync(join(root, ".interlinked/check-policy.json"), policy("block"));
		expect(evaluateBaselineIntegrityForEvent(writeEvent(root, ".interlinked/check-policy.json", "{}"))?.decision).toBe("block");
	});
	it("allows ordinary historical check customizations", () => {
		const root = project(true);
		const file = join(root, ".interlinked/check-policy.json");
		writeFileSync(file, JSON.stringify({ checks: { test_without_description: { action: "warn_after" } } }));
		expect(evaluateBaselineIntegrityForEvent(writeEvent(root, ".interlinked/check-policy.json", JSON.stringify({ checks: { test_without_description: { action: "silent" } } })))).toBeNull();
	});
	it("restores adopted policy after a shell-channel effect", () => {
		const root = project(), file = join(root, ".interlinked/check-policy.json"), before = policy("block", 5);
		writeFileSync(file, before);
		rememberBaselineSnapshot("metric-shell", root);
		writeFileSync(file, policy("warn", 20));
		expect(consumeBaselineSnapshot("metric-shell", root)).toContain("RESTORED");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
	it("restores absence when a new team file disables inherited enforcement", () => {
		const root = project(true), file = join(root, ".interlinked/check-policy.json");
		rememberBaselineSnapshot("metric-new", root);
		writeFileSync(file, policy("off"));
		expect(consumeBaselineSnapshot("metric-new", root)).toContain("RESTORED");
		expect(existsSync(file)).toBe(false);
	});
	it("does not restore unrelated check-policy edits", () => {
		const root = project(true), file = join(root, ".interlinked/check-policy.json");
		writeFileSync(file, "{}");
		rememberBaselineSnapshot("metric-unrelated", root);
		const after = JSON.stringify({ checks: { test_without_description: { action: "silent" } } });
		writeFileSync(file, after);
		expect(consumeBaselineSnapshot("metric-unrelated", root)).toBeNull();
		expect(readFileSync(file, "utf8")).toBe(after);
	});
	it("keeps dry-run comparisons free of restoration and audit writes", () => {
		const root = project(), file = join(root, ".interlinked/check-policy.json");
		writeFileSync(file, policy("block"));
		rememberBaselineSnapshot("metric-dry", root);
		writeFileSync(file, policy("off"));
		expect(consumeBaselineSnapshot("metric-dry", root, { dryRun: true })).toBeNull();
		expect(readFileSync(file, "utf8")).toBe(policy("off"));
		expect(existsSync(join(root, ".interlinked/baseline-undo"))).toBe(false);
	});
});
