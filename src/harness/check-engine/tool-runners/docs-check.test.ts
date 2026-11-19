import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "../spawn-async.js";
import { runDocsCheckAsync } from "./docs-check.js";

vi.mock("../spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input() {
	const root = mkdtempSync(join(resolve("scratch"), "docs-check-"));
	roots.push(root);
	mkdirSync(join(root, "scripts"));
	writeFileSync(join(root, "scripts/check-docs.mjs"), "throw new Error('mock process boundary');");
	return { scope: { projectRoot: root, mode: "project" as const }, timeoutMs: 1000 };
}
it("runs only the selected root-local documentation script", async () => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false, killed: false });
	const request = input();
	expect(await runDocsCheckAsync(request)).toEqual([]);
	expect(runProcessAsync).toHaveBeenCalledWith(process.execPath, ["scripts/check-docs.mjs"], { cwd: request.scope.projectRoot, timeout: 1000 });
});
it("retains parsed drift from a failing documentation check", async () => {
	const request = input();
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 1, stdout: `[docs:fail] ${request.scope.projectRoot}/README.md: rule_count drift\n  expected: 1\n  actual: 2`, stderr: "", timedOut: false, killed: false });
	expect(await runDocsCheckAsync(request)).toEqual([expect.objectContaining({ tool: "docs-check", file: "README.md" })]);
});
it.each([
	{ code: 1, timedOut: false, killed: false },
	{ code: null, timedOut: false, killed: true },
	{ code: 0, timedOut: true, killed: true },
])("preserves genuine documentation runner failure %j", async result => {
	vi.mocked(runProcessAsync).mockResolvedValue({ ...result, stdout: "", stderr: "Unavailable" });
	await expect(runDocsCheckAsync(input())).rejects.toThrow("no check verdict");
});
