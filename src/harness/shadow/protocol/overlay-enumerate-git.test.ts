import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectLocalTreeInputs } from "./overlay-enumerate.js";
import { asCanonicalPath } from "./path-rules.js";
import type { OverlayIncludeRuleV1, OverlayManifestV1 } from "./types-core.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shadow-literal-roots-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), "*\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function ignoredFile(path: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), "export const value = 1;\n");
}

function collect(rules: OverlayIncludeRuleV1[]) {
	const manifest: OverlayManifestV1 = { schema_version: 1, include_rules: rules, deny_ruleset_id: "shadow-overlay-deny-v1" };
	return collectLocalTreeInputs(args => execFileSync("git", [...args], { cwd: root }), manifest);
}

describe("overlay ignored-path discovery through real Git", () => {
	it.each(["file[1].ts", "file*.ts", ":(literal)config.ts", ":(exclude)config.ts", "notes ' $(echo ignored).ts"])("treats an exact filename as bytes, without selector or shell interpretation: %s", path => {
		ignoredFile(path);
		ignoredFile("file1.ts");
		ignoredFile("config.ts");
		expect(collect([{ kind: "exact", path: asCanonicalPath(path) }])).toEqual({
			ok: true,
			sets: { tracked: [], untracked: [], ignoredCandidates: [path] },
		});
	});

	it("walks a pattern's literal directory prefix without reinterpreting Git magic", () => {
		ignoredFile(":(literal)state/input.json");
		ignoredFile("state/unrelated.json");
		expect(collect([{ kind: "gitwildmatch-v1", pattern: ":(literal)state/**" }])).toEqual({
			ok: true,
			sets: { tracked: [], untracked: [], ignoredCandidates: [":(literal)state/input.json"] },
		});
	});

	it("retains whole-tree discovery for a basename pattern", () => {
		ignoredFile("src/input.ts");
		ignoredFile("nested/deep/other.ts");
		expect(collect([{ kind: "gitwildmatch-v1", pattern: "*.ts" }])).toEqual({
			ok: true,
			sets: { tracked: [], untracked: [], ignoredCandidates: [".gitignore", "nested/deep/other.ts", "src/input.ts"] },
		});
	});
});
