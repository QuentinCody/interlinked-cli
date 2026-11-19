import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildFunctionTokenMetricsReport } from "./metrics-function-tokens.js";
import { discoverFunctionTokenFiles } from "./verify/file-discovery.js";

const failures = vi.hoisted(() => ({ directories: new Set<string>() }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
		if (failures.directories.has(String(args[0]))) throw Object.assign(new Error("EACCES: selected directory is unreadable"), { code: "EACCES" });
		return actual.readdirSync(...args);
	} };
});
const roots: string[] = [];
function project(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "function-token-discovery-"))); roots.push(root);
	mkdirSync(join(root, "src")); writeFileSync(join(root, "src/good.ts"), "export function good() { return 1; }\n");
	return root;
}
afterEach(() => { failures.directories.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("retains a real dangling source alias as a standalone function-token discovery gap", () => {
	const root = project(); symlinkSync("missing-target.ts", join(root, "src/dangling.ts"));
	const gaps: { file: string; reason: string }[] = [];
	expect(discoverFunctionTokenFiles(root, { onUnavailable: gap => gaps.push(gap) })).toEqual([join(root, "src/good.ts")]);
	expect(gaps).toEqual([expect.objectContaining({ file: "src/dangling.ts", reason: expect.stringContaining("ENOENT") })]);
	const report = buildFunctionTokenMetricsReport({ cwd: root });
	expect(report.functions.map(row => row.name)).toEqual(["good"]);
	expect(report.scope.unmeasuredFiles).toBe(1);
	expect(report.notMeasured).toEqual([expect.objectContaining({ file: "src/dangling.ts", kind: "unreadable", reason: expect.stringContaining("ENOENT") })]);
});

it("retains inaccessible directory scope while measuring readable filesystem siblings", () => {
	const root = project(), blocked = join(root, "src/blocked"); mkdirSync(blocked);
	writeFileSync(join(blocked, "hidden.ts"), "export function hidden() { return 2; }"); failures.directories.add(blocked);
	const report = buildFunctionTokenMetricsReport({ cwd: root });
	expect(report.functions.map(row => row.name)).toEqual(["good"]);
	expect(report.scope.unmeasuredFiles).toBe(1);
	expect(report.notMeasured).toEqual([expect.objectContaining({ file: "src/blocked", kind: "unreadable", reason: expect.stringContaining("EACCES") })]);
});

it("preserves native Git ignored scope and complete function bodies in the standalone report", () => {
	const root = project(); execFileSync("git", ["init", "--quiet"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), "ignored.ts\n"); writeFileSync(join(root, "ignored.ts"), "export function ignored() { return 0; }");
	writeFileSync(join(root, "src/large.ts"), `// ${"x".repeat(2 * 1024 * 1024)}\nexport function atEnd() { return 2; }\n`);
	const report = buildFunctionTokenMetricsReport({ cwd: root });
	expect(report.functions.map(row => row.name).sort()).toEqual(["atEnd", "good"]);
	expect(report.notMeasured).toEqual([]);
});
