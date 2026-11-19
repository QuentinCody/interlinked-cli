import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tryAcquireProjectCompilerLease } from "../../project-compiler-gate.js";
import { withProcessCancellation } from "../process-cancellation.js";
import { runProcessAsync } from "../spawn-async.js";
import { runTscAsync } from "./tsc.js";

vi.mock("../spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tsc-foreground-admission-"));
	writeFileSync(join(root, "tsconfig.json"), '{"files":["a.ts"]}');
	writeFileSync(join(root, "a.ts"), "export const answer = 42;\n");
	vi.mocked(runProcessAsync).mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false, killed: false });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function input(timeoutMs = 0) {
	return { scope: { projectRoot: root, mode: "project" as const }, timeoutMs, resourcePolicy: "foreground-verify" as const };
}

it("admits foreground TypeScript after a holder releases beyond the old two-second deadline", async () => {
	const release = tryAcquireProjectCompilerLease(root);
	expect(release).not.toBeNull();
	const pending = runTscAsync(input());
	const timer = setTimeout(() => release?.(), 2100);
	try {
		expect(await pending).toEqual([]);
		expect(runProcessAsync).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 0 }));
	} finally { clearTimeout(timer); release?.(); }
}, 7000);

it("spends a positive caller tool budget across compiler admission and execution", async () => {
	const release = tryAcquireProjectCompilerLease(root);
	expect(release).not.toBeNull();
	const pending = runTscAsync(input(500));
	const timer = setTimeout(() => release?.(), 80);
	try {
		expect(await pending).toEqual([]);
		const timeout = vi.mocked(runProcessAsync).mock.calls[0]?.[2]?.timeout;
		expect(timeout).toBeGreaterThan(0);
		expect(timeout).toBeLessThan(450);
	} finally { clearTimeout(timer); release?.(); }
});

it("cancels queued foreground TypeScript without spawning or stealing the holder's lease", async () => {
	const release = tryAcquireProjectCompilerLease(root);
	expect(release).not.toBeNull();
	const controller = new AbortController();
	const pending = withProcessCancellation(controller.signal, () => runTscAsync(input()));
	controller.abort();
	try {
		expect(await pending).toMatchObject([{ ruleId: "tsc-unavailable", message: expect.stringContaining("aborted") }]);
		expect(runProcessAsync).not.toHaveBeenCalled();
		expect(tryAcquireProjectCompilerLease(root)).toBeNull();
	} finally { release?.(); }
});
