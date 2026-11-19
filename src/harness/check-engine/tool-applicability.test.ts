import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectApplicableTools, selectToolsForRun } from "./tool-applicability.js";
import { inventoryPaths } from "../../lib/metrics/inventory-paths.js";
import type { ToolId } from "./types.js";

vi.mock("../../lib/metrics/inventory-paths.js", async (original) => ({ ...await original<typeof import("../../lib/metrics/inventory-paths.js")>(), inventoryPaths: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string {
	const root = mkdtempSync(join(resolve("scratch"), "tool-applicability-"));
	roots.push(root);
	return root;
}
const tools = (...ids: ToolId[]) => ids.map(id => ({ id, available: true }));

describe("external tool applicability", () => {
	it("failed availability probes are unknown; absence, exclusions and inapplicability remain distinct", () => {
		vi.mocked(inventoryPaths).mockReturnValue({ discovery: "git", paths: ["index.js"], issues: [] });
		const selected = [
			{ id: "gitleaks" as const, available: false, probeError: "Version probe timed out" },
			{ id: "eslint" as const, available: false, reason: "not installed" },
			{ id: "rustfmt" as const, available: false, probeError: "Version probe timed out" },
		];
		const scope = { projectRoot: project(), mode: "project" as const };
		expect(selectToolsForRun(selected, scope).skipped).toEqual([
			{ check: "gitleaks", category: "error", reason: "Version probe timed out" },
			{ check: "eslint", category: "tool_missing", reason: "not installed" },
			{ check: "rustfmt", category: "file_type_mismatch", reason: "No selected Rust source files" },
		]);
		expect(selectToolsForRun(selected, scope, { skipTools: ["gitleaks"] }).skipped[0]?.category).toBe("config_disabled");
	});

	it("MUST-FIRE: excludes Rust/C tools for a complete JavaScript-only inventory", () => {
		vi.mocked(inventoryPaths).mockReturnValue({ discovery: "git", paths: ["index.js", "test.js"], issues: [] });
		const result = selectApplicableTools(tools("rustfmt", "c-compile", "gitleaks"), { projectRoot: project(), mode: "project" });
		expect(result.applicable.map(tool => tool.id)).toEqual(["gitleaks"]);
		expect(result.skipped).toEqual([
			{ check: "rustfmt", category: "file_type_mismatch", reason: "No selected Rust source files" },
			{ check: "c-compile", category: "file_type_mismatch", reason: "No selected C/C++ source files" },
		]);
		expect(inventoryPaths).toHaveBeenCalledTimes(1);
	});

	it.each(["src/lib.rs", "src/main.c", "include/types.hxx", "src/main.C", "src/bridge.mm"])("MUST-NOT-FIRE: retains relevant source %s", path => {
		vi.mocked(inventoryPaths).mockReturnValue({ discovery: "filesystem", paths: [path], issues: [] });
		const id = path.endsWith(".rs") ? "rustfmt" : "c-compile";
		expect(selectApplicableTools(tools(id), { projectRoot: project(), mode: "project" }).applicable).toEqual(tools(id));
	});

	it("MUST-NOT-FIRE: incomplete discovery cannot establish language absence", () => {
		vi.mocked(inventoryPaths).mockReturnValue({ discovery: "filesystem", paths: [], issues: ["Discovery reached limit"] });
		expect(selectApplicableTools(tools("rustfmt", "c-compile"), { projectRoot: project(), mode: "project" }).skipped)
			.toEqual([{ check: "rustfmt", category: "error", reason: "Discovery reached limit" }]);
	});

	it("uses the selected file extension without project enumeration", () => {
		vi.mocked(inventoryPaths).mockClear();
		expect(selectApplicableTools(tools("rustfmt", "c-compile"), { projectRoot: project(), mode: "file", targetFile: "main.rs" }).applicable).toEqual(tools("rustfmt"));
		expect(inventoryPaths).not.toHaveBeenCalled();
	});

	it("MUST-FIRE: ancestor package/docs configuration does not apply to a selected child", () => {
		vi.mocked(inventoryPaths).mockReturnValue({ discovery: "filesystem", paths: [], issues: [] });
		const root = project();
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts/check-docs.mjs"), "throw new Error('unrelated script must never execute');");
		writeFileSync(join(root, "package.json"), "{}");
		const child = join(root, "child");
		mkdirSync(child);
		const result = selectApplicableTools(tools("docs-check", "dep-audit"), { projectRoot: child, mode: "project" });
		expect(result.applicable).toEqual([]);
		expect(result.skipped.every(row => row.category === "file_type_mismatch")).toBe(true);
	});

	it("MUST-NOT-FIRE: root-local docs script and package retain capability requirements", () => {
		vi.mocked(inventoryPaths).mockReturnValue({ discovery: "filesystem", paths: ["package.json"], issues: [] });
		const root = project();
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts/check-docs.mjs"), "throw new Error('inspection does not execute scripts');");
		writeFileSync(join(root, "package.json"), "{}");
		expect(selectApplicableTools(tools("docs-check", "dep-audit"), { projectRoot: root, mode: "project" }).applicable).toEqual(tools("docs-check", "dep-audit"));
	});

	it.each(["go.mod", "Cargo.lock", "requirements.txt", "services/api/pom.xml"])("retains non-Node dependency scope %s without a package.json", path => {
		vi.mocked(inventoryPaths).mockReturnValue({ discovery: "git", paths: [path], issues: [] });
		expect(selectApplicableTools(tools("dep-audit"), { projectRoot: project(), mode: "project" }).applicable).toEqual(tools("dep-audit"));
	});
});
