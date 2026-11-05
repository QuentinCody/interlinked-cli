// ===========================================
// Kill proof — preconditions checked before any vitest run
// ===========================================
// Split from run.ts (line cap). Everything here decides whether a proof can START, without
// running anything: the mutated bytes still parse in the file's dialect (introduced-only JSX,
// round-4 layouts M1), the target is product code (not a test, a data file, a manual mock —
// A3 — or node_modules), the project's `vitest` is found where `npx vitest` would find it
// (its own node_modules or a HOISTED workspace root's, M5) and `--vitest-config` resolves the
// way the shell spelled it, inside the project (M7/A4/A6).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type * as TS from "typescript";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { isTestPath } from "../coverage-test-selector.js";
import type { HoistedModules } from "../fail-before-fix/snapshot.js";
import { loadTsModule } from "../mutation/differential-fuzz-deps.js";
import type { ResolvedMutant } from "./types.js";

/**
 * The mutated source must still parse: a syntax error is a compile error, not behaviour (review K5). JSX in a
 * `.js`/`.ts` file is refused INTRODUCED-ONLY (round-4 layouts M1): when `original` already holds JSX the
 * project's own vitest transforms the file (a CRA-era `.js` with a jsx plugin), the baseline proved it loads,
 * and the mutant is judged by the run like any other; only a mutant that ADDS JSX to a JSX-free file is refused.
 */
export function mutantParses(file: string, mutated: string, original?: string): { ok: true } | { ok: false; reason: string } | null {
	const ts = loadTsModule();
	if (ts === null) return null;
	// Parse in the file's OWN dialect (review L6: JSX in a `.js` file is not JavaScript); binder-level early
	// errors (a redeclared `let`) need a program and are not checked — vitest's transpiler does not check them either.
	const ext = getExtension(file);
	const kind = ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX : ext.startsWith(".ts") || ext === ".mts" || ext === ".cts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const sf = ts.createSourceFile(file, mutated, ts.ScriptTarget.ES2022, true, kind);
	const syntax = (sf as unknown as { parseDiagnostics?: TS.Diagnostic[] }).parseDiagnostics?.find(d => d.category === ts.DiagnosticCategory.Error);
	if (syntax !== undefined) {
		const text = ts.flattenDiagnosticMessageText(syntax.messageText, " ");
		return { ok: false, reason: `the mutated ${file} does not parse (${text}); a compile error is not a kill` };
	}
	// TypeScript's parser accepts JSX in any file and leaves the complaint to the checker; a `.js`/`.ts` file is not JSX.
	if ((kind === ts.ScriptKind.JS || kind === ts.ScriptKind.TS) && containsJsx(ts, sf) && !(original !== undefined && containsJsx(ts, ts.createSourceFile(file, original, ts.ScriptTarget.ES2022, true, kind)))) {
		return { ok: false, reason: `the mutated ${file} introduces JSX, which ${ext} files cannot hold; a compile error is not a kill` };
	}
	return { ok: true };
}

function containsJsx(ts: NonNullable<ReturnType<typeof loadTsModule>>, node: TS.Node): boolean {
	if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
	let found = false;
	ts.forEachChild(node, child => {
		if (!found && containsJsx(ts, child)) found = true;
	});
	return found;
}

const OTHER_RUNNERS = ["jest", "ava", "mocha", "uvu", "tap", "node:test", "jasmine", "bun:test"];

/**
 * The directory whose `node_modules/.bin/vitest` serves `root` (round-4 layouts M5): `root` itself, else the nearest
 * ancestor up to the git root — a hoisted workspace install (npm/pnpm/yarn default) lives at the workspace root and
 * `npx vitest` from a package finds it there. Null when none exists within the repository.
 */
export function vitestHome(root: string): string | null {
	let current = root;
	for (;;) {
		if (existsSync(join(current, "node_modules", ".bin", "vitest"))) return current;
		if (existsSync(join(current, ".git"))) return null;
		const parent = resolve(current, "..");
		if (parent === current) return null;
		current = parent;
	}
}

/** The copy layout a hoisted install needs (`snapshot.ts HoistedModules`), or undefined when `root` owns its vitest. */
export function hoistLayout(root: string): HoistedModules | undefined {
	const home = vitestHome(root);
	if (home === null || home === root) return undefined;
	return { prefix: relative(home, root), hoistedModules: join(home, "node_modules") };
}

/** v1 runs vitest only; say so, and name the runner the project does declare (review: a jest repo blamed its tests). */
export function missingVitest(root: string): string | null {
	if (vitestHome(root) !== null) return null;
	let declared = "";
	try {
		const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (typeof pkg === "object" && pkg !== null) {
			const deps = { ...(pkg as { dependencies?: Record<string, string> }).dependencies, ...(pkg as { devDependencies?: Record<string, string> }).devDependencies };
			const found = OTHER_RUNNERS.filter(name => name in deps);
			const script = (pkg as { scripts?: Record<string, string> }).scripts?.test;
			if ("workspaces" in pkg || existsSync(join(root, "pnpm-workspace.yaml"))) return "vitest is not installed at this workspace root; pass --cwd <package> for a package that has vitest";
			if (found.length) declared = ` (this project declares ${found.join(", ")})`;
			else if (script) declared = ` (its test script is \`${script}\`)`;
		}
	} catch {
		declared = "";
	}
	return `vitest is not installed in this project${declared}; v1 of prove-kill runs vitest only`;
}

export function targetProblem(mutant: ResolvedMutant, tests: readonly string[]): string | null {
	if (tests.includes(mutant.file)) return `${mutant.file} is both the mutated source and a named test`;
	if (!JS_TS_EXTS.has(getExtension(mutant.file))) return `${mutant.file} is not a JS/TS source file; a proof mutates product code, not data or fixtures`;
	if (isTestPath(mutant.file)) return `${mutant.file} is a test file; a proof mutates product code`;
	if (mutant.file.split("/").includes("node_modules")) return `${mutant.file} is under node_modules`;
	if (mutant.file.split("/").includes("__mocks__")) return `${mutant.file} is a manual mock (under __mocks__), not product code; a proof over a mock proves nothing about the module it stands in for`;
	return null;
}

/**
 * `--vitest-config` as the shell spells it (round-4 layouts M7/A4/A6): absolute, relative to the invoking cwd, or
 * relative to the project root — in that order, the first that exists — normalized to a repo-relative POSIX path
 * (so `./configs/x.mts` and `configs/x.mts` are one spelling). A file that resolves OUTSIDE the project is refused
 * up front: the copy cannot carry it, and handing it to vitest only ends as an anonymous "no JSON report".
 */
export function explicitVitestConfig(root: string, spelled: string, cwd = process.cwd()): string | { reason: string } {
	const candidates = (isAbsolute(spelled) ? [spelled] : [resolve(cwd, spelled), resolve(root, spelled)]).filter(abs => existsSync(abs));
	if (candidates.length === 0) return { reason: `--vitest-config ${spelled} does not exist` };
	const inside = (abs: string): string | null => {
		const rel = relative(root, realpathSync(abs)).replace(/\\/g, "/");
		return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
	};
	const rel = candidates.map(inside).find((candidate): candidate is string => candidate !== null);
	return rel ?? { reason: `--vitest-config ${spelled} resolves outside the project (${candidates[0]}); the copy cannot carry it, so the proof cannot run it` };
}
