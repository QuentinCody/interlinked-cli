import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "../spawn-async.js";
import { PartialToolReportError } from "../tool-errors.js";
import type { ToolRunnerInput } from "../types.js";
import { runRustfmtCheckAsync } from "./rust.js";

vi.mock("../spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const roots: string[] = [];
beforeEach(() => vi.mocked(runProcessAsync).mockReset());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string {
	const root = mkdtempSync(join(tmpdir(), "rustfmt-async-")); roots.push(root);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "Cargo.toml"), '[package]\nname="example"\nversion="0.1.0"\nedition="2024"\n');
	writeFileSync(join(root, "src/lib.rs"), "pub fn value()->u8{1}\n");
	return root;
}
function input(root: string): ToolRunnerInput { return { scope: { projectRoot: root, mode: "project" }, timeoutMs: 0, resourcePolicy: "foreground-verify" }; }
const clean = { code: 0, stdout: "", stderr: "", timedOut: false, killed: false };

it("runs only the root Cargo crate/workspace, offline and read-only, with complete foreground capture", async () => {
	const root = project(); vi.mocked(runProcessAsync).mockResolvedValue(clean);
	expect(await runRustfmtCheckAsync(input(root))).toEqual([]);
	expect(runProcessAsync).toHaveBeenCalledExactlyOnceWith("cargo", ["fmt", "--manifest-path", join(root, "Cargo.toml"), "--", "--check", "--color=never"],
		expect.objectContaining({ cwd: root, timeout: 0, maxBufferBytes: null, env: expect.objectContaining({ CARGO_NET_OFFLINE: "true", RUSTUP_AUTO_INSTALL: "0" }) }));
});

it("retains diffs even when a formatter returns exit zero", async () => {
	const root = project(); vi.mocked(runProcessAsync).mockResolvedValue({ ...clean, stdout: `Diff in ${join(root, "src/lib.rs")}:1:\n` });
	expect(await runRustfmtCheckAsync(input(root))).toMatchObject([{ file: "src/lib.rs", line: 1, tool: "rustfmt" }]);
});

it("selects every declared workspace member through native metadata without including path dependencies", async () => {
	const root = project(); writeFileSync(join(root, "Cargo.toml"), '[workspace]\nmembers=["fixtures/a", "tests/b"]\n');
	vi.mocked(runProcessAsync).mockResolvedValueOnce({ ...clean, stdout: JSON.stringify({ workspace_members: ["a", "b"],
		packages: [{ id: "a", name: "member_a" }, { id: "b", name: "member_b" }, { id: "dependency", name: "external" }] }) }).mockResolvedValue(clean);
	expect(await runRustfmtCheckAsync(input(root))).toEqual([]);
	expect(vi.mocked(runProcessAsync).mock.calls[0]).toEqual(["cargo", ["metadata", "--offline", "--no-deps", "--format-version", "1", "--manifest-path", join(root, "Cargo.toml")],
		expect.objectContaining({ timeout: 0, maxBufferBytes: null })]);
	expect(vi.mocked(runProcessAsync).mock.calls[1]?.[1]).toEqual(["fmt", "--manifest-path", join(root, "Cargo.toml"), "--package", "member_a", "--package", "member_b", "--", "--check", "--color=never"]);
});

it.each(["not JSON", JSON.stringify({ workspace_members: ["missing"], packages: [] })])("does not turn invalid workspace metadata into an empty formatting verdict %s", async stdout => {
	const root = project(); writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
	vi.mocked(runProcessAsync).mockResolvedValue({ ...clean, stdout });
	await expect(runRustfmtCheckAsync(input(root))).rejects.toThrow();
	expect(runProcessAsync).toHaveBeenCalledTimes(1);
});

it.each([
	{ ...clean, code: 1, stderr: "error: expected item" },
	{ ...clean, code: null }, { ...clean, code: 2 }, { ...clean, timedOut: true },
	{ ...clean, killed: true }, { ...clean, stdoutTruncated: true },
])("keeps incomplete native outcomes unavailable %j", async result => {
	const root = project(); vi.mocked(runProcessAsync).mockResolvedValue(result);
	await expect(runRustfmtCheckAsync(input(root))).rejects.toThrow(PartialToolReportError);
});

it("retains positives beside native parse failures", async () => {
	const root = project(); vi.mocked(runProcessAsync).mockResolvedValue({ ...clean, code: 1,
		stdout: `Diff in ${join(root, "src/lib.rs")}:1:\n`, stderr: "error: could not parse another module" });
    const result: unknown = await runRustfmtCheckAsync(input(root)).catch((error: unknown) => error);
	expect(result).toBeInstanceOf(PartialToolReportError);
	if (!(result instanceof PartialToolReportError)) throw new Error("Expected partial Rust formatting evidence");
	expect(result.results).toMatchObject([{ file: "src/lib.rs" }]);
});

it("uses direct rustfmt with the crate edition and preserves single-file output filtering", async () => {
	const root = project(), target = join(root, "src/lib.rs");
	vi.mocked(runProcessAsync).mockResolvedValue({ ...clean, code: 1, stdout: `Diff in ${target}:1:\nDiff in ${join(root, "src/child.rs")}:2:\n` });
	const results = await runRustfmtCheckAsync({ ...input(root), scope: { projectRoot: root, mode: "file", targetFile: target, filterToFile: true } });
	expect(results).toHaveLength(1); expect(results[0]?.file).toBe("src/lib.rs");
	expect(runProcessAsync).toHaveBeenCalledWith("rustfmt", ["--check", "--color=never", "--edition", "2024", target], expect.objectContaining({ timeout: 0 }));
});

it("preserves bounded background capture and the supplied deadline", async () => {
	const root = project(); vi.mocked(runProcessAsync).mockResolvedValue(clean);
	await runRustfmtCheckAsync({ scope: { projectRoot: root, mode: "file", targetFile: join(root, "src/lib.rs") }, timeoutMs: 1234 });
	expect(runProcessAsync).toHaveBeenCalledWith("rustfmt", expect.any(Array), expect.objectContaining({ timeout: expect.any(Number) }));
	const options = vi.mocked(runProcessAsync).mock.calls[0]?.[2];
	expect(options).not.toHaveProperty("maxBufferBytes");
	expect(options?.timeout).toBeLessThanOrEqual(1234);
});
