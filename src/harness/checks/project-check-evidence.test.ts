import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getProjectCheckEvidence, withProjectCheckEvidence } from "./project-check-evidence.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string {
	const root = mkdtempSync(join(resolve("scratch"), "project-check-evidence-"));
	roots.push(root);
	return root;
}
async function nativeReads(): Promise<void> {
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
	vi.mocked(readFileSync).mockClear();
}

it("MUST-FIRE: repeated consumers share one complete source read within an invocation", async () => {
	await nativeReads();
	const root = project(), file = join(root, "index.ts");
	const body = `${"// complete input\n".repeat(20_000)}export const answer = 42;\n`;
	writeFileSync(file, body);
	withProjectCheckEvidence(root, [file], () => {
		const evidence = getProjectCheckEvidence(root);
		expect(evidence?.readFile(file)).toBe(body);
		expect(evidence?.readFile("index.ts")).toBe(body);
		expect(evidence?.listFiles()).toEqual(["index.ts"]);
	});
	const sourceReads = vi.mocked(readFileSync).mock.calls.filter(([path]) => path === file);
	expect(sourceReads).toHaveLength(1);
	expect(getProjectCheckEvidence(root)).toBeUndefined();
});

it("MUST-NOT-FIRE: a second invocation observes changed bytes and a new file", async () => {
	await nativeReads();
	const root = project(), file = join(root, "index.ts"), added = join(root, "added.ts");
	writeFileSync(file, "before");
	withProjectCheckEvidence(root, [file], () => expect(getProjectCheckEvidence(root)?.readFile(file)).toBe("before"));
	writeFileSync(file, "after");
	writeFileSync(added, "new");
	withProjectCheckEvidence(root, [file, added], () => {
		expect(getProjectCheckEvidence(root)?.readFile(file)).toBe("after");
		expect(getProjectCheckEvidence(root)?.listFiles()).toEqual(["index.ts", "added.ts"]);
	});
});

it("retains unreadable evidence, memoizes its failure and reports each check/file gap once", async () => {
	await nativeReads();
	const root = project(), file = join(root, "missing.ts"), onGap = vi.fn();
	withProjectCheckEvidence(root, [file], () => {
		const evidence = getProjectCheckEvidence(root);
		expect(() => evidence?.readFile(file)).toThrow();
		expect(() => evidence?.readFile(file)).toThrow();
		evidence?.reportGaps("export_ripple");
		evidence?.reportGaps("export_ripple");
		evidence?.reportGaps("dead_exports");
		expect(evidence?.complete).toBe(false);
	}, onGap);
	expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === file)).toHaveLength(1);
	expect(onGap.mock.calls.map(([gap]) => gap.check)).toEqual(["export_ripple", "dead_exports"]);
	expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ file: "missing.ts", reason: expect.stringContaining("ENOENT") }));
});

it("preserves nested and asynchronous invocation isolation", async () => {
	await nativeReads();
	const outer = project(), inner = project();
	await withProjectCheckEvidence(outer, [], async () => {
		const outerEvidence = getProjectCheckEvidence(outer);
		expect(getProjectCheckEvidence()).toBe(outerEvidence);
		await withProjectCheckEvidence(inner, [], async () => {
			await Promise.resolve();
			expect(getProjectCheckEvidence(outer)).toBeUndefined();
			expect(getProjectCheckEvidence(inner)).toBeDefined();
			expect(getProjectCheckEvidence()).toBe(getProjectCheckEvidence(inner));
		});
		expect(getProjectCheckEvidence(outer)).toBe(outerEvidence);
		expect(getProjectCheckEvidence()).toBe(outerEvidence);
	});
	expect(getProjectCheckEvidence(outer)).toBeUndefined();
	expect(getProjectCheckEvidence()).toBeUndefined();
});

it("does not make unrelated non-source read failures into import-analysis gaps", async () => {
	await nativeReads();
	const root = project(), file = join(root, "index.ts"), missing = join(root, "README.md"), onGap = vi.fn();
	writeFileSync(file, "export const answer = 42;");
	withProjectCheckEvidence(root, [file, missing], () => {
		const evidence = getProjectCheckEvidence(root);
		expect(() => evidence?.readFile(missing)).toThrow();
		evidence?.sources();
		expect(evidence?.complete).toBe(true);
		evidence?.reportGaps("export_ripple");
	}, onGap);
	expect(onGap).not.toHaveBeenCalled();
});
