import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../types.js";
import { loadStructuralMetricPolicy, STRUCTURAL_METRIC_KEYS } from "../metric-policy-config.js";
import { checkFunctionComplexityWrite } from "./complexity-write-guard.js";
import { evaluatePreChecksTail } from "./pre-tool-phases.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const content = `export function validate(x: number) { ${Array.from({ length: 30 }, (_, n) => `if (x === ${n}) return ${n};`).join(" ")} return -1; }`;

function project(metric: string, entry: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "structural-metric-policy-"));
	roots.push(root); mkdirSync(join(root, ".interlinked"));
	const metrics: Record<string, unknown> = Object.fromEntries(STRUCTURAL_METRIC_KEYS.map(key => [key, { mode: "off" }]));
	metrics[metric] = entry;
	writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify({ metrics }));
	return root;
}
function run(root: string, file = "src/a.ts", dryRun = false, patch = false) {
	const input = patch
		? { command: `*** Begin Patch\n*** Add File: ${file}\n+${content}\n*** End Patch` }
		: { file_path: join(root, file), content };
	const tool = patch ? "apply_patch" : "Write";
	const event: HarnessEvent = { hook_event: "PreToolUse", session_id: "metric-policy", agent_source: "codex", timestamp: "2026-11-11T00:00:00Z", cwd: root, tool_name: tool, tool_input: input, dry_run: dryRun };
	const warnings: string[] = [];
	return { decision: evaluatePreChecksTail(event, undefined, undefined, tool, input, warnings), warnings };
}

describe.each(STRUCTURAL_METRIC_KEYS)("%s normal structural edit policy", metric => {
	it.each(["report", "warn", "block", "off"])("applies %s disposition independently", mode => {
		const root = project(metric, { mode, threshold: 5 });
		const result = run(root);
		expect(result.decision?.decision ?? "allow").toBe(mode === "block" ? "block" : "allow");
		expect(result.warnings.some(warning => warning.includes("edit-metrics"))).toBe(mode === "warn");
		if (mode === "report") {
			const records = readFileSync(join(root, ".interlinked/check-executions.jsonl"), "utf8");
			expect(records).toContain(`"check":"metric-policy:${metric}"`);
			expect(records).toContain('"delivered":false');
			expect(records).toContain("reporting target 5");
		}
	});
	it("filters relative path scope for direct and apply_patch writes", () => {
		const root = project(metric, { mode: "block", threshold: 5, scope: { paths: ["src/**"], roles: ["product"] } });
		for (const patch of [false, true]) {
			expect(run(root, "src/a.ts", false, patch).decision?.decision).toBe("block");
			expect(run(root, "scripts/a.ts", false, patch).decision).toBeNull();
		}
	});
	it("honors role scope without widening the existing eligible population", () => {
		const root = project(metric, { mode: "block", threshold: 5, scope: { roles: ["test"] } });
		expect(run(root).decision).toBeNull();
		expect(run(root, "src/a.test.ts").decision).toBeNull();
	});
	it("keeps report dry runs free of capture writes", () => {
		const root = project(metric, { mode: "report", threshold: 5 });
		expect(run(root, "src/a.ts", true).decision).toBeNull();
		expect(existsSync(join(root, ".interlinked/check-executions.jsonl"))).toBe(false);
	});
	it("preserves hold-or-shrink behavior under an explicit blocking target", () => {
		const root = project(metric, { mode: "block", threshold: 5 });
		mkdirSync(join(root, "src")); writeFileSync(join(root, "src/a.ts"), content);
		expect(run(root).decision).toBeNull();
	});
});

it("retains measurements when policy is off or the file is excluded", () => {
	for (const entry of [{ mode: "off" }, { mode: "block", scope: { paths: ["other/**"] } }]) {
		const root = project("cyclomatic", entry), observe = vi.fn();
		checkFunctionComplexityWrite({ file_path: join(root, "src/a.ts"), content }, root, observe, loadStructuralMetricPolicy(root, "cyclomatic"));
		expect(observe).toHaveBeenCalledOnce();
		expect(observe.mock.calls[0]?.[2]?.[0]?.cyclomatic).toBe(31);
	}
});

it("retains independent blocking when another structural metric warns", () => {
	const root = project("cyclomatic", { mode: "warn", threshold: 5 });
	writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify({ metrics: { cyclomatic: { mode: "warn", threshold: 5 }, cognitive: { mode: "block", threshold: 5 }, "function-tokens": { mode: "off" } } }));
	const result = run(root);
		expect(result.decision?.rule_id).toBe("cognitive-cap");
		expect(result.warnings.join("\n")).toContain("cyclomatic");
});

it("reports configured unsupported metric coverage explicitly", () => {
	const root = project("coverage", { mode: "block", threshold: 90 });
	expect(run(root).warnings.join("\n")).toContain("coverage policy is not applied by structural edit hooks");
});

it("cannot raise canonical enforcement with a higher block target", () => {
	const root = project("cyclomatic", { mode: "block", threshold: 999 });
	writeFileSync(join(root, ".interlinked/metric-caps.json"), JSON.stringify({ max_cyclomatic: 10 }));
	expect(run(root).decision?.reason).toContain("10-branch cap");
});

it("retains inherited enforcement for malformed metric policy", () => {
	const root = project("cyclomatic", { mode: "invalid", threshold: -1 });
	writeFileSync(join(root, ".interlinked/config.json"), JSON.stringify({ harness: { edit_metrics: { mode: "enforced" } } }));
	const result = run(root);
	expect(result.decision?.decision).toBe("block");
	expect(result.warnings.join("\n")).toContain("Invalid metric policy cyclomatic");
});
