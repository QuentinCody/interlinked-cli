import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import { checkRoot, reportNotMeasured, withCheckRoot } from "../checks/check-root.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import type { WriteContentGuardState } from "./write-content-basic-guards.js";
import { runPreWarnRegistry } from "./write-content-overlay-guards.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "prewarn-barrel-evidence-"));
	put("package.json", JSON.stringify({ name: "@prewarn/selected-project" }));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function state(content = 'import { value } from "./index.js";', dryRun = false): WriteContentGuardState {
	put("src/foo.ts", content);
	return {
		toolName: "Write", filePath: "src/foo.ts", content, preEditContent: undefined, postEditContent: content,
		event: { hook_event: "PreToolUse", session_id: "isolated-prewarn", tool_use_id: "write-call", agent_source: "codex",
			cwd: root, timestamp: "2026-11-12T00:00:00Z", dry_run: dryRun },
		rules: makeGuardRules(), session: undefined, externalOverlays: false, warnings: [], escalation: undefined,
	};
}

function observations(): Record<string, unknown>[] {
	const file = join(root, ".interlinked/check-executions.jsonl");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

describe("prewarn own-barrel evidence", () => {
	it("P1 persists actual unavailable evidence and a warning for a missing selected-root graph", () => {
		const input = state();
		runPreWarnRegistry(input);
		expect(input.warnings.some(message => message.includes("[interlinked:import_from_own_barrel] NOT MEASURED:"))).toBe(true);
		expect(observations()).toContainEqual(expect.objectContaining({
			schema: "hook-observation.v1", hook_event: "PreToolUse", session_id: "isolated-prewarn", tool_use_id: "write-call",
			check: "import_from_own_barrel", kind: "advisory", measurementState: "unavailable", findingCount: 0,
			file: "src/foo.ts", message: expect.stringContaining(root),
		}));
	});

	it("N1 preserves an unavailable dry-run warning without writing observation or capture receipts", () => {
		const input = state(undefined, true);
		runPreWarnRegistry(input);
		expect(input.warnings.some(message => message.includes("NOT MEASURED"))).toBe(true);
		expect(observations()).toEqual([]);
		expect(existsSync(join(root, ".interlinked/capture-receipts.jsonl"))).toBe(false);
	});

	it("P2 uses event root for relative sources and restores the enclosing check root", () => {
		put("src/index.ts", 'export * from "./foo.js";');
		const input = state();
		withCheckRoot("/unrelated/enclosing-project", () => {
			runPreWarnRegistry(input);
			expect(checkRoot()).toBe("/unrelated/enclosing-project");
		});
		expect(input.warnings.some(message => message.includes("advisory graph/policy observation(s)"))).toBe(true);
		expect(input.warnings.join("\n")).toContain("imports from own-directory barrel");
		expect(input.warnings.join("\n")).not.toContain("violation(s)");
		expect(observations()).toEqual([]);
	});

	it("P3 labels an exact own-package import as policy advice without a runtime-violation claim", () => {
		const input = state('import { value } from "@prewarn/selected-project";');
		runPreWarnRegistry(input);
		const warning = input.warnings.find(message => message.startsWith("[interlinked:import_from_own_barrel]"));
		expect(warning).toContain("advisory graph/policy observation(s)");
		expect(warning).toContain("imports from own package");
		expect(warning).not.toContain("violation(s)");
		expect(observations()).toEqual([]);
	});

	it("N2 emits no own-barrel warning or unavailable receipt for a complete nonreturning graph", () => {
		put("src/index.ts", "export const value = 1;");
		const input = state();
		runPreWarnRegistry(input);
		expect(input.warnings.filter(message => message.includes("[interlinked:import_from_own_barrel]"))).toEqual([]);
		expect(observations()).toEqual([]);
	});

	it("P4 retains a positive witness alongside the separate unavailable graph receipt", () => {
		put("src/index.ts", 'export * from "./foo.js";\nexport * from "./missing.js";');
		const input = state();
		runPreWarnRegistry(input);
		const warnings = input.warnings.filter(message => message.includes("[interlinked:import_from_own_barrel]"));
		expect(warnings.some(message => message.includes("advisory graph/policy observation(s)"))).toBe(true);
		expect(warnings.some(message => message.includes("NOT MEASURED"))).toBe(true);
		expect(observations()).toContainEqual(expect.objectContaining({
			kind: "advisory", check: "import_from_own_barrel", measurementState: "unavailable", findingCount: 0,
			message: expect.stringContaining("missing.js"),
		}));
	});

	it("P5 retains notice capacity beyond the JavaScript call argument ceiling without persisting a dry run", () => {
		const check = CHECK_REGISTRY.find(entry => entry.id === "import_from_own_barrel")!;
		vi.spyOn(check, "fn").mockImplementation(() => {
			for (let index = 0; index < 150_001; index++) reportNotMeasured(check.id, `unresolved module control ${index}`);
			return [];
		});
		const input = state(undefined, true);
		expect(() => runPreWarnRegistry(input)).not.toThrow();
		const notices = input.warnings.filter(message => message.startsWith("[interlinked:import_from_own_barrel] NOT MEASURED:"));
		expect(notices).toHaveLength(150_001);
		expect(notices.at(-1)).toContain("unresolved module control 150000");
		expect(observations()).toEqual([]);
	});
});
