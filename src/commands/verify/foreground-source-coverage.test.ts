import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { timingSnapshot, withVerifyTimings, type VerifyCheckTiming } from "./check-timing.js";
import { createScanProgress } from "./scan-progress.js";
import { runCodeQualityChecks, runCodeQualityChecksProgressive } from "./tool-results.js";
import { checkRoot } from "../../harness/checks/check-root.js";

const failure = vi.hoisted(() => ({ mode: "none" as "none" | "program" | "loader" | "loader-throw", roots: [] as string[] }));
vi.mock("../../harness/checks/check-typescript.js", async original => {
	const actual = await original<typeof import("../../harness/checks/check-typescript.js")>();
	return { ...actual, loadCheckTypescript: (check: string, purpose: string) => {
		const ts = actual.loadCheckTypescript(check, purpose);
		if (check !== "type_smuggling") return ts;
		failure.roots.push(checkRoot());
		if (failure.mode === "loader-throw") throw new Error("TypeScript loader failed");
		if (failure.mode === "loader") return null;
		if (!ts || failure.mode !== "program") return ts;
		return new Proxy(ts, { get(target, property) {
			if (property === "createProgram") return () => { throw new Error("Compiler program unavailable"); };
			return Reflect.get(target, property);
		} });
	} };
});

let root: string;
let originalExit: typeof process.exitCode;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "verify-foreground-coverage-"));
	originalExit = process.exitCode;
	failure.mode = "none";
	failure.roots.length = 0;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); process.exitCode = originalExit; });
function source(name: string, content: string): string {
	const file = join(root, name); writeFileSync(file, content); return file;
}
async function collect(files: string[], progressive = false) {
	let coverage: VerifyCheckTiming[] = [];
	const result = await withVerifyTimings(root, () => progressive
		? runCodeQualityChecksProgressive(files, root, createScanProgress(files.length))
		: runCodeQualityChecks(files, root), {
		skipChecks: getEffectiveSkipChecks(undefined, false),
		onFinish: run => { coverage = timingSnapshot(run); },
	});
	return { result, coverage };
}

it.each([false, true])("retains default parity evidence beyond 256KiB through the public collector (progressive=%s)", async progressive => {
	const prefix = `/*${" ".repeat(256 * 1024)}*/\n`;
	const a = source("a.js", `${prefix}function choose(event) { switch (event.kind) { case "a": return 1; } }\n`);
	const b = source("b.js", `${prefix}function choose(event) { switch (event.kind) { case "b": return 2; } }\n`);
	const { result, coverage } = await collect([a, b], progressive);
	expect(result.crossFileSwitchDiscriminant.map(row => row.file).sort()).toEqual(["a.js", "b.js"]);
	expect(result.projectLocRatio).toHaveLength(1);
	expect(result.projectLocRatio[0]?.message).toContain("Prod 6 LOC");
	expect(coverage.find(row => row.check === "project_parity")?.skipped).toBe(0);
});

it.each([false, true])("retains default incompatible-cast evidence beyond 1000 lines (progressive=%s)", async progressive => {
	const file = source("cast.ts", `${"\n".repeat(1000)}const observed = "hello" as number;`);
	const { result, coverage } = await collect([file], progressive);
	expect(result.typeSmuggling).toContainEqual(expect.objectContaining({ file: "cast.ts", line: 1001 }));
	expect(coverage.find(row => row.check === "type_smuggling")?.skipped).toBe(0);
});

it("retains every default cast finding beyond the hook's ten-result limit", async () => {
	const file = source("casts.ts", Array.from({ length: 12 }, (_, index) => `const cast${index} = "hello" as number;`).join("\n"));
	const { result } = await collect([file]);
	expect(result.typeSmuggling.map(row => row.line)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
});

it("resolves optional compiler evidence from the selected foreign project root", async () => {
	const file = source("foreign.ts", 'const observed = "hello" as number;');
	const { result } = await collect([file]);
	expect(result.typeSmuggling).toHaveLength(1);
	expect(failure.roots).toEqual([root]);
	expect(checkRoot()).toBe(process.cwd());
});

it.each(["program", "loader", "loader-throw"] as const)("records unavailable type-smuggling %s evidence through the public collector", async mode => {
	failure.mode = mode;
	const file = source("cast.ts", 'const observed = "hello" as number;');
	const { result, coverage } = await collect([file]);
	expect(result.typeSmuggling).toEqual([]);
	expect(coverage).toContainEqual(expect.objectContaining({ check: "type_smuggling", skipped: 1,
		unavailable_inputs: [expect.objectContaining({ file: "cast.ts", reason: expect.stringMatching(/compiler|typescript/i) })] }));
	expect(process.exitCode).toBe(75);
	expect(checkRoot()).toBe(process.cwd());
});

it("keeps irrelevant assertions complete when no compiler program is needed", async () => {
	failure.mode = "program";
	const file = source("ordinary.ts", 'const value = "hello" as const;');
	const { result, coverage } = await collect([file]);
	expect(result.typeSmuggling).toEqual([]);
	expect(coverage.find(row => row.check === "type_smuggling")?.skipped).toBe(0);
});

it("records recovered syntax as unknown type evidence alongside readable source checks", async () => {
	const file = source("broken.ts", 'const observed = "hello" as number;\nfunction broken(');
	const { coverage } = await collect([file]);
	expect(coverage).toContainEqual(expect.objectContaining({ check: "type_smuggling", skipped: 1,
		unavailable_inputs: [expect.objectContaining({ file: "broken.ts", reason: expect.stringMatching(/syntax|pars/i) })] }));
	expect(process.exitCode).toBe(75);
});

it("retains named unknown parity inputs instead of treating a missing source as measured", async () => {
	const file = source("missing.ts", "export const missing = true;");
	unlinkSync(file);
	const { coverage } = await collect([file]);
	expect(coverage).toContainEqual(expect.objectContaining({ check: "project_parity", skipped: 1,
		unavailable_inputs: [expect.objectContaining({ file: "missing.ts", reason: expect.stringContaining("ENOENT") })] }));
	expect(process.exitCode).toBe(75);
});
