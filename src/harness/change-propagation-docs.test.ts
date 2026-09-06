// ===========================================
// Change Propagation — docs-category helper tests
// ===========================================
// `docDocsDir` is exercised end-to-end (real fixtures) through
// `findPropagationTargets` in change-propagation.test.ts; this file targets it
// directly, including its `find` injection seam — added so the outer
// try/catch (a defensive wrapper around a call whose real implementation,
// `findFilesRecursive`, already swallows every error it or its recursion can
// throw) has a reachable trigger at all.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docDocsDir, type PropagationCtx } from "./change-propagation-docs.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "change-prop-docs-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Build a PropagationCtx the way change-propagation.ts derives one. */
function ctxFor(cwd: string, rel: string): PropagationCtx {
	const editedFile = join(cwd, rel);
	const ext = extname(rel);
	const name = rel.split("/").pop() ?? rel;
	return {
		editedFile,
		cwd,
		rel,
		name,
		ext,
		dir: join(cwd, rel, ".."),
		nameNoExt: name.slice(0, name.length - ext.length),
	};
}

describe("docDocsDir — happy path", () => {
	it("collects a docs/ file that mentions the edited module's name", () => {
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "guide.md"), "the widget module does things");
		const targets = docDocsDir(ctxFor(root, "src/widget.ts"));
		expect(targets).toEqual([
			{
				file: join(root, "docs", "guide.md"),
				reason: 'Documentation references "widget" — verify it\'s still accurate',
				category: "documentation",
				confidence: "medium",
			},
		]);
	});

	it("returns no targets when docs/ does not exist", () => {
		const targets = docDocsDir(ctxFor(root, "src/widget.ts"));
		expect(targets).toEqual([]);
	});
});

describe("docDocsDir — find injection seam (outer try/catch)", () => {
	it("returns no targets and does not throw when the injected finder throws", () => {
		mkdirSync(join(root, "docs"), { recursive: true });
		const throwingFind = (): string[] => {
			throw new Error("simulated: a failure findFilesRecursive's own catch never lets escape");
		};
		const targets = docDocsDir(ctxFor(root, "src/widget.ts"), throwingFind);
		expect(targets).toEqual([]);
	});

	it("uses the injected finder's file list instead of walking the real docs/ tree", () => {
		mkdirSync(join(root, "docs"), { recursive: true });
		// Real docs/ is empty; the injected finder points at a file that lives
		// elsewhere, proving `find`'s return value drives the loop rather than
		// the real recursive walk over docsDir.
		const decoyDoc = join(root, "elsewhere.md");
		mkdirSync(root, { recursive: true });
		writeFileSync(decoyDoc, "widget reference");
		const targets = docDocsDir(ctxFor(root, "src/widget.ts"), () => [decoyDoc]);
		expect(targets).toEqual([
			{
				file: decoyDoc,
				reason: 'Documentation references "widget" — verify it\'s still accurate',
				category: "documentation",
				confidence: "medium",
			},
		]);
	});
});
