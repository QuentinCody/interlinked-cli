import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import { timingSnapshot, withVerifyTimings, type VerifyCheckTiming } from "./check-timing.js";
import { createScanProgress } from "./scan-progress.js";
import { runCodeQualityChecksProgressive } from "./tool-results.js";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { withProcessCancellation } from "../../harness/check-engine/process-cancellation.js";

vi.mock("../../harness/check-engine/spawn-async.js", async original => {
	const actual = await original<typeof import("../../harness/check-engine/spawn-async.js")>();
	return { ...actual, runProcessAsync: vi.fn(actual.runProcessAsync) };
});
const roots: string[] = [];
const originalExit = process.exitCode;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); process.exitCode = originalExit; vi.mocked(runProcessAsync).mockClear(); });
const body = (name: string) => `def ${name}(value):\n    first = load(value)\n    second = copy(first)\n    second.status = "done"\n    second.token = None\n    second.expiry = None\n    return second\n`;
async function collect(content: string, selected = true, name = "queue.py") {
	const root = mkdtempSync(join(resolve("scratch"), "repeated-foreground-")); roots.push(root);
	const file = join(root, name); writeFileSync(file, content);
	const skipChecks = new Set(CHECK_REGISTRY.map(check => check.id));
	if (selected) skipChecks.delete("repeated_implementation");
	let coverage: VerifyCheckTiming[] = [];
	const result = await withVerifyTimings(root, () => runCodeQualityChecksProgressive([file], root, createScanProgress(1)), { skipChecks, onFinish: run => { coverage = timingSnapshot(run); } });
	return { result, coverage };
}

it("MUST-FIRE: public progressive collection retains Python repetition past the hook body ceiling", async () => {
	const { result, coverage } = await collect(`#${"x".repeat(300 * 1024)}\n${body("first")}${body("second")}`);
	expect(result.repeatedImplementation).toEqual([expect.objectContaining({ file: "queue.py", message: expect.stringContaining("2 similar implementations") })]);
	expect(coverage.find(row => row.check === "repeated_implementation")).toMatchObject({ calls: 1, skipped: 0 });
});

it("preserves source suppression after the asynchronous result is collected", async () => {
	const implementation = '(value) { const a = load(value); const b = copy(a); b.status = "done"; b.token = null; b.expiry = null; return b; }';
	const { result } = await collect(`// interlinked-ignore: repeated_implementation — contracts intentionally differ\nfunction first${implementation}\nfunction second${implementation}`, true, "queue.ts");
	expect(result.repeatedImplementation).toEqual([]);
});

it("MUST-NOT-FIRE: intentional exclusion prevents the Python subprocess", async () => {
	const { result, coverage } = await collect(body("first") + body("second"), false);
	expect(result.repeatedImplementation).toEqual([]);
	expect(runProcessAsync).not.toHaveBeenCalled();
	expect(coverage.find(row => row.check === "repeated_implementation")).toBeUndefined();
});

it("records parser failure as named unavailable evidence and partial verification", async () => {
	const { result, coverage } = await collect("def broken(:");
	expect(result.repeatedImplementation[0]?.message).toContain("NOT CHECKED");
	expect(coverage.find(row => row.check === "repeated_implementation")).toMatchObject({ skipped: 1, unavailable_inputs: [expect.objectContaining({ file: "queue.py", reason: expect.stringContaining("Python parser did not complete") })] });
	expect(process.exitCode).toBe(75);
});

it("propagates foreground cancellation after retaining unavailable parser coverage", async () => {
	const controller = new AbortController();
	vi.mocked(runProcessAsync).mockImplementationOnce(() => new Promise(resolve => {
		controller.signal.addEventListener("abort", () => resolve({ code: null, stdout: "[]", stderr: "", killed: true, timedOut: false }), { once: true });
	}));
	const pending = withProcessCancellation(controller.signal, () => collect(body("first") + body("second")));
	const timer = setTimeout(() => controller.abort(new Error("verification cancelled")), 40);
	try {
		await expect(pending).rejects.toThrow("verification cancelled");
		expect(process.exitCode).toBe(75);
	} finally { clearTimeout(timer); }
});
