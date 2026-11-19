import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINT_INPUT_MAX_BYTES } from "./discovery.js";
import { prepareLintImport } from "./selection.js";

const roots: string[] = [];
function project(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-skip-")));
	roots.push(root);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const BIG = "x".repeat(LINT_INPUT_MAX_BYTES + 1);

describe("lint scan skips oversized context files instead of aborting", () => {
	it("skips an oversized lockfile and says so, and the scan stays complete", () => {
		const root = project({ ".oxlintrc.json": "{}", "package.json": "{}", "pnpm-lock.yaml": BIG });
		const { inventory, policy } = prepareLintImport(root, {}, null);
		expect(inventory.complete).toBe(true);
		expect(inventory.skipped).toEqual([{ file: "pnpm-lock.yaml", reason: `Context file over ${LINT_INPUT_MAX_BYTES} bytes; not read, so changes to it are not tracked` }]);
		expect(inventory.sources.map(source => source.file)).not.toContain("pnpm-lock.yaml");
		expect(Object.keys(policy.digests)).not.toContain("pnpm-lock.yaml");
		expect(policy.entries.map(entry => entry.tool)).toContain("oxlint");
	});
	it("lists a skipped file once however many scopes reach it", () => {
		const root = project({ ".oxlintrc.json": "{}", "packages/app/.oxlintrc.json": "{}", "pnpm-lock.yaml": BIG });
		const { inventory } = prepareLintImport(root, {}, null);
		expect(inventory.skipped?.filter(row => row.file === "pnpm-lock.yaml")).toHaveLength(1);
	});
	it("still reads a lockfile under the limit as dependency context", () => {
		const root = project({ ".oxlintrc.json": "{}", "package-lock.json": "{}\n" });
		const { inventory, policy } = prepareLintImport(root, {}, null);
		expect(inventory.skipped ?? []).toEqual([]);
		expect(Object.keys(policy.digests)).toContain("package-lock.json");
	});
	it("still reports an oversized configuration file as a gap, not as skipped context", () => {
		const root = project({ ".oxlintrc.json": `{"k":"${BIG}"}` });
		const { inventory } = prepareLintImport(root, {}, null);
		expect(inventory.complete).toBe(false);
		expect(inventory.warnings.join("\n")).toMatch(/\.oxlintrc\.json.*not inspected/);
		expect(inventory.skipped ?? []).toEqual([]);
	});
});
