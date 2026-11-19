import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFileLineWriteAdvice, collectObservedFileLineAdvice } from "./file-line-policy.js";
import { evaluatePreChecksTail } from "./evaluator/pre-tool-phases.js";
import { collectPostWriteFileWarnings } from "./evaluator/post-tool-write-warnings.js";
import type { HarnessEvent } from "./types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const content = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join("\n");
function project(entry?: unknown): { root: string; path: string; event: HarnessEvent } {
	const root = mkdtempSync(join(tmpdir(), "file-line-policy-")); roots.push(root);
	mkdirSync(join(root, ".interlinked")); mkdirSync(join(root, "src"));
	if (entry !== undefined) writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify({ metrics: { "file.lines": entry } }));
	const path = join(root, "src/a.ts");
	return { root, path, event: { hook_event: "PreToolUse", session_id: "line-policy", agent_source: "codex", timestamp: "2026-11-11T00:00:00Z", cwd: root, tool_name: "Write", tool_input: { file_path: path, content } } };
}

describe("physical line advisory policy", () => {
	it.each(["report", "warn", "off"])("applies %s at normal pre/post entrypoints while retaining source", mode => {
		const { root, path, event } = project({ mode, threshold: 5 });
		const warnings: string[] = [];
		expect(evaluatePreChecksTail(event, undefined, undefined, "Write", event.tool_input ?? {}, warnings)).toBeNull();
		expect(warnings.some(warning => warning.includes("file-size") && warning.includes("advisory"))).toBe(mode === "warn");
		writeFileSync(path, content);
		const post = collectPostWriteFileWarnings({ ...event, hook_event: "PostToolUse" });
		expect(post.some(warning => warning.includes("file-size") && warning.includes("advisory"))).toBe(mode === "warn");
		expect(collectObservedFileLineAdvice({ ...event, tool_name: "Read" }, path, 12).length > 0).toBe(mode === "warn");
		expect(readFileSync(path, "utf8")).toBe(content);
		if (mode === "report") {
			const evidence = readFileSync(join(root, ".interlinked/check-executions.jsonl"), "utf8");
			expect(evidence).toContain('"check":"metric-policy:file.lines"');
			expect(evidence).toContain("12 lines");
			expect(evidence).toContain('"delivered":false');
		}
	});
	it("keeps missing policy and explicit block requests advisory", () => {
		const { event } = project();
		expect(collectFileLineWriteAdvice(event, event.tool_input ?? {})).toEqual([]);
		const blocked = project({ mode: "block", threshold: 5 });
		const warnings: string[] = [];
		expect(evaluatePreChecksTail(blocked.event, undefined, undefined, "Write", blocked.event.tool_input ?? {}, warnings)).toBeNull();
		expect(warnings.join("\n")).toContain("no qualified blocking predicate");
		expect(warnings.join("\n")).toContain("reporting target 5");
	});
	it("honors positive path/role scopes and keeps dry runs free of evidence writes", () => {
		const selected = project({ mode: "report", threshold: 5, scope: { paths: ["src/**"], roles: ["product"] } });
		collectFileLineWriteAdvice({ ...selected.event, dry_run: true }, selected.event.tool_input ?? {});
		expect(existsSync(join(selected.root, ".interlinked/check-executions.jsonl"))).toBe(false);
		const excluded = project({ mode: "warn", threshold: 5, scope: { paths: ["scripts/**"] } });
		expect(collectFileLineWriteAdvice(excluded.event, excluded.event.tool_input ?? {})).toEqual([]);
		expect(collectObservedFileLineAdvice(excluded.event, excluded.path, 12)).toEqual([]);
	});
	it("keeps patch projection and shrinking/comment exemptions", () => {
		const { root, path, event } = project({ mode: "warn", threshold: 5 });
		const patch = `*** Begin Patch\n*** Add File: src/a.ts\n${content.split("\n").map(line => `+${line}`).join("\n")}\n*** End Patch`;
		expect(collectFileLineWriteAdvice({ ...event, tool_name: "apply_patch" }, { command: patch }).join("\n")).toContain("reporting target 5");
		writeFileSync(path, content);
		expect(collectFileLineWriteAdvice(event, { file_path: path, content })).toEqual([]);
		expect(collectFileLineWriteAdvice(event, { file_path: path, content: `${content}\n// documentation` })).toEqual([]);
		expect(readFileSync(join(root, ".interlinked/check-policy.json"), "utf8")).toContain('"threshold":5');
	});
	it("resolves relative post-write paths against the event project", () => {
		const { path, event } = project({ mode: "warn", threshold: 5 }); writeFileSync(path, content);
		const warnings = collectPostWriteFileWarnings({ ...event, tool_input: { file_path: "src/a.ts", content } });
		expect(warnings.join("\n")).toContain("reporting target 5");
	});
});
