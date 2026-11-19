import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withVerifyTimings } from "./check-timing.js";

vi.mock("node:child_process", () => ({ execSync: () => { throw new Error("Git unavailable"); } }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, readdirSync: vi.fn(fs.readdirSync), lstatSync: vi.fn(fs.lstatSync) };
});
import { lstatSync, readdirSync } from "node:fs";
import { discoverFiles } from "./file-discovery.js";

const roots: string[] = [];
const originalExit = process.exitCode;
afterEach(() => {
	vi.mocked(readdirSync).mockRestore();
	vi.mocked(lstatSync).mockRestore();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	process.exitCode = originalExit;
});
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "verify-discovery-safety-")); roots.push(root);
	writeFileSync(join(root, "good.ts"), "export const good = true;");
	return root;
}
function receipts(root: string): unknown[] {
	return readFileSync(join(root, ".interlinked/verify-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

it("retains discovery failures for a caller without an active timing run", () => {
	const root = fixture(); symlinkSync("missing.ts", join(root, "dangling.ts"));
	const issues: Array<{ file: string; reason: string }> = [];
	expect(discoverFiles(root, { onUnavailable: issue => issues.push(issue) })).toEqual([join(root, "good.ts")]);
	expect(issues).toEqual([{ file: "dangling.ts", reason: expect.stringContaining("ENOENT") }]);
});

it("does not traverse a symbolic-link cycle and names the unavailable input", async () => {
	const root = fixture();
	symlinkSync(root, join(root, "cycle"), "dir");
	await withVerifyTimings(root, () => {
		expect(discoverFiles(root)).toEqual([join(root, "good.ts")]);
	});
	expect(process.exitCode).toBe(75);
	expect(receipts(root)).toContainEqual(expect.objectContaining({ check: "file_discovery_unavailable", status: "partial",
		unavailable_inputs: [{ file: "cycle", reason: expect.stringContaining("symbolic link") }] }));
});

it("retains a contained regular-file alias once under its source path", async () => {
	const root = fixture(), alias = join(root, "alias.ts");
	symlinkSync("good.ts", alias);
	await withVerifyTimings(root, () => {
		const paths = discoverFiles(root);
		expect(paths).toEqual([alias, join(root, "good.ts")]);
		expect(new Set(paths).size).toBe(paths.length);
	});
	expect(process.exitCode).toBe(originalExit);
});

it.each(["outside", "dangling"])("retains an explicit gap for a %s file alias", async (kind) => {
	const root = fixture(), alias = join(root, "alias.ts");
	const outside = fixture();
	symlinkSync(kind === "outside" ? join(outside, "good.ts") : "missing.ts", alias);
	await withVerifyTimings(root, () => expect(discoverFiles(root)).toEqual([join(root, "good.ts")]));
	expect(process.exitCode).toBe(75);
	expect(receipts(root)).toContainEqual(expect.objectContaining({ check: "file_discovery_unavailable", status: "partial",
		unavailable_inputs: [{ file: "alias.ts", reason: expect.stringMatching(kind === "outside" ? /outside/ : /ENOENT/) }] }));
});

it("records a file-alias cycle without following it indefinitely", async () => {
	const root = fixture();
	symlinkSync("second.ts", join(root, "first.ts"));
	symlinkSync("first.ts", join(root, "second.ts"));
	await withVerifyTimings(root, () => expect(discoverFiles(root)).toEqual([join(root, "good.ts")]));
	expect(process.exitCode).toBe(75);
	expect(receipts(root)).toContainEqual(expect.objectContaining({ check: "file_discovery_unavailable", skipped: 2,
		unavailable_inputs: [
			{ file: "first.ts", reason: expect.stringContaining("ELOOP") },
			{ file: "second.ts", reason: expect.stringContaining("ELOOP") },
		] }));
});

it("keeps excluded binary aliases out of coverage gaps while traversing text inside a similarly named directory", async () => {
	const root = fixture();
	symlinkSync("missing.png", join(root, "excluded.png"));
	mkdirSync(join(root, "docs.png"));
	writeFileSync(join(root, "docs.png", "source.ts"), "export const source = true;");
	await withVerifyTimings(root, () => expect(discoverFiles(root).sort()).toEqual([
		join(root, "docs.png", "source.ts"), join(root, "good.ts"),
	].sort()));
	expect(process.exitCode).toBe(originalExit);
});

it("continues through readable siblings when a directory cannot be listed", async () => {
	const root = fixture(), blocked = join(root, "blocked");
	mkdirSync(blocked);
	vi.mocked(readdirSync).mockImplementationOnce(() => ["blocked", "good.ts"] as never)
		.mockImplementationOnce(() => { throw Object.assign(new Error("directory denied"), { code: "EACCES" }); });
	await withVerifyTimings(root, () => expect(discoverFiles(root)).toEqual([join(root, "good.ts")]));
	expect(process.exitCode).toBe(75);
	expect(receipts(root)).toContainEqual(expect.objectContaining({ check: "file_discovery_unavailable", status: "partial",
		unavailable_inputs: [{ file: "blocked", reason: expect.stringContaining("EACCES") }] }));
});

it("isolates a failed file stat without dropping later siblings", async () => {
	const root = fixture();
	writeFileSync(join(root, "a.ts"), "export const a = true;");
	vi.mocked(lstatSync).mockImplementationOnce(() => { throw Object.assign(new Error("source denied"), { code: "EACCES" }); });
	await withVerifyTimings(root, () => expect(discoverFiles(root)).toEqual([join(root, "good.ts")]));
	expect(process.exitCode).toBe(75);
	expect(receipts(root)).toContainEqual(expect.objectContaining({ check: "file_discovery_unavailable", status: "partial",
		unavailable_inputs: [{ file: "a.ts", reason: expect.stringContaining("EACCES") }] }));
});

it("records failed Git inventory in an existing worktree before attempting the filesystem fallback", async () => {
	const root = fixture();
	mkdirSync(join(root, ".git"));
	await withVerifyTimings(root, () => expect(discoverFiles(root)).toEqual([join(root, "good.ts")]));
	expect(process.exitCode).toBe(75);
	expect(receipts(root)).toContainEqual(expect.objectContaining({ check: "file_discovery_unavailable", status: "partial",
		unavailable_inputs: [{ file: ".", reason: "Git unavailable" }] }));
});
