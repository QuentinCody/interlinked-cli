import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkDeadTypeExportsAtCwd,
	checkDuplicateTypeDeclarationAtCwd,
} from "../check-registry/entries-warnings/type-discipline.js";
import { checkDuplicateTypeDeclaration } from "./type-redundancy.js";

/** Real git fixture: getGitSourceFiles shells to `git ls-files`, so the repo
 *  view must be an actual repository. */
let root: string;
function fixture(files: Record<string, string>): string {
	root = mkdtempSync(join(tmpdir(), "type-redundancy-"));
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), content);
	}
	execSync("git init -q && git add -A", { cwd: root });
	return root;
}
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("checkDuplicateTypeDeclaration — positive (must fire)", () => {
	it("P1: same name, identical body in a sibling module → merge guidance", () => {
		const content = "export interface Shape {\n\tid: string;\n}\n";
		const cwd = fixture({
			"src/a.ts": content,
			"src/b.ts": "export interface Shape {\n\tid: string;\n}\n",
		});
		const out = checkDuplicateTypeDeclaration(content, join(cwd, "src/a.ts"), cwd);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("IDENTICAL body");
		expect(out[0]?.line).toBe(1);
	});

	it("P2: same name, different body → rename guidance", () => {
		const content = "export interface Shape {\n\tid: string;\n}\n";
		const cwd = fixture({
			"src/a.ts": content,
			"src/b.ts": "export interface Shape {\n\tcount: number;\n}\n",
		});
		const out = checkDuplicateTypeDeclaration(content, join(cwd, "src/a.ts"), cwd);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("DIFFERENT body");
	});
});

describe("checkDuplicateTypeDeclaration — negative (must not fire)", () => {
	it("N1: a unique type name in the repo is silent", () => {
		const content = "export interface OnlyHere {\n\tid: string;\n}\n";
		const cwd = fixture({
			"src/a.ts": content,
			"src/b.ts": "export interface Other {\n\tid: string;\n}\n",
		});
		expect(checkDuplicateTypeDeclaration(content, join(cwd, "src/a.ts"), cwd)).toEqual([]);
	});

	it("N2: a homonym declared only in a TEST file does not count", () => {
		const content = "export interface Shape {\n\tid: string;\n}\n";
		const cwd = fixture({
			"src/a.ts": content,
			"src/b.test.ts": "export interface Shape {\n\tid: string;\n}\n",
		});
		expect(checkDuplicateTypeDeclaration(content, join(cwd, "src/a.ts"), cwd)).toEqual([]);
	});

	it("N3: the edited file being a test file is exempt", () => {
		const content = "export interface Shape {\n\tid: string;\n}\n";
		const cwd = fixture({
			"src/a.test.ts": content,
			"src/b.ts": "export interface Shape {\n\tid: string;\n}\n",
		});
		expect(checkDuplicateTypeDeclaration(content, join(cwd, "src/a.test.ts"), cwd)).toEqual([]);
	});
});

describe("registry wrappers (AtCwd) — behave identically over a real repo view", () => {
	it("P3: checkDuplicateTypeDeclarationAtCwd fires on a homonym", () => {
		const content = "export interface Shape {\n\tid: string;\n}\n";
		const cwd = fixture({
			"src/a.ts": content,
			"src/b.ts": "export interface Shape {\n\tid: string;\n}\n",
		});
		const out = checkDuplicateTypeDeclarationAtCwd(content, join(cwd, "src/a.ts"), cwd);
		expect(out).toHaveLength(1);
	});

	it("P4: checkDeadTypeExportsAtCwd flags an unconsumed interface with proven resolution", () => {
		const content = "export const used = 1;\nexport interface DeadShape { id: string }\n";
		const cwd = fixture({
			"src/lib.ts": content,
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		});
		const out = checkDeadTypeExportsAtCwd(content, join(cwd, "src/lib.ts"), cwd);
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'DeadShape'")]);
	});

	it("N4: checkDeadTypeExportsAtCwd stays silent for a type consumed via import type", () => {
		const content = "export const used = 1;\nexport interface LiveShape { id: string }\n";
		const cwd = fixture({
			"src/lib.ts": content,
			"src/main.ts":
				'import { used } from "./lib.js";\nimport type { LiveShape } from "./lib.js";\nexport function f(x: LiveShape): number { return Number(x.id) + used; }\n',
		});
		expect(checkDeadTypeExportsAtCwd(content, join(cwd, "src/lib.ts"), cwd)).toEqual([]);
	});
});
