// ===========================================
// Helper hygiene — two edit-time (pre_warn) nudges at extraction time
// ===========================================
// Both detectors judge the DELTA of one edit, not the file: the on-disk file
// at PreToolUse is the pre-edit state, so the registry wrappers read it and
// hand the pure cores an explicit `preContent`. At PostToolUse / verify the
// disk already equals the content, the delta is empty, and both stay silent —
// pre_warn semantics by construction, never a second copy of `dead_exports`
// or `code_clones` on the post-edit audit.
//
//   new_export_without_importer — an edit that ADDS an exported value symbol
//     nothing (or only a test) imports. The reflex being nudged: exporting a
//     freshly extracted helper so the test can reach it directly, instead of
//     keeping it module-private and testing through the caller. Brand-new
//     files are exempt: under the exporter-before-importers rule a new module
//     has zero importers at write time by definition. A rename (one export
//     removed, a same-shaped one added in the same edit) is not a new export.
//     Consumers are filtered with the strict test predicate only — this
//     package's own detector modules are production consumers.
//   extracted_helper_duplicate — a function NEW to this edit whose body is at
//     least 90% shingle-similar to a function in a sibling module: the helper
//     the agent just extracted already exists next door. Stricter than
//     code_clones (0.82) and cross-file only; same-file pairs stay with
//     code_clones. The exporter-first MOVE flow — the edited file is brand
//     new, or a same-directory sibling holds a >=99% identical copy — is a
//     move in progress, not a duplicate: one info-level finding per sibling
//     file names the count and steers at deleting the originals, instead of
//     one "import it instead" finding per moved function. A genuine
//     re-extraction (90-99% similar: renamed/edited, not verbatim) still gets
//     the import-it remedy. Limit: a same-session function added to BOTH
//     files at >=99% similarity reads as a move too — indistinguishable from
//     one side of the pair without extra signal.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseExports } from "../project-graph/parser-exports.js";
import { computeCyclomaticComplexity } from "./cyclomatic.js";
import {
	type DeadExportsArgs,
	type DeadExportsRepo,
	findDeadExports,
} from "./dead-exports-inline.js";
import { collectSiblingFunctions } from "./dry-check.js";
import { extractFunctionShingles, findClones, type FunctionShingles } from "./dry.js";
import { getGitSourceFiles } from "./export-ripple.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isTestSourcePath,
	JS_TS_EXTS,
} from "./shared.js";

/** Shared input for both cores: proposed content plus the pre-edit state. */
export interface HelperHygieneArgs {
	/** Proposed FULL post-edit content. */
	content: string;
	filePath: string;
	/** Content before the edit; `null` when the file does not exist yet. */
	preContent: string | null;
	cwd?: string;
}

/** Jaccard bar for "this helper already exists" — stricter than code_clones. */
export const HELPER_DUPLICATE_THRESHOLD = 0.9;

// ===========================================
// new_export_without_importer
// ===========================================

/** Exported value kinds a helper extraction produces (types are erased). */
const VALUE_KINDS = new Set(["function", "const", "let", "var", "class"]);

/** Value exports by name → declaration line. */
function valueExports(content: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of parseExports(content)) {
		if (!e.isTypeOnly && VALUE_KINDS.has(e.kind)) out.set(e.name, e.line);
	}
	return out;
}

/** A declaration's text from its line to the next column-0 construct, with
 *  the declared name blanked and whitespace collapsed — the shape two
 *  declarations share when one is a rename of the other. */
function declarationShape(lines: string[], line: number, name: string): string {
	let end = line;
	while (end < lines.length && !/^[^\s})\]]/.test(lines[end] ?? "")) end++;
	const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
	return lines
		.slice(line - 1, end)
		.join("\n")
		.replace(nameRe, "<name>")
		.replace(/\s+/g, " ")
		.trim();
}

/** Shapes of the value exports `preContent` has that `after` no longer names. */
function removedShapes(preContent: string, after: Map<string, number>): Set<string> {
	const lines = preContent.split("\n");
	const out = new Set<string>();
	for (const [name, line] of valueExports(preContent)) {
		if (!after.has(name)) out.add(declarationShape(lines, line, name));
	}
	return out;
}

/** Line → name for every value export the edit introduces over `preContent`.
 *  An export removed and a same-shaped export added in one edit is a rename,
 *  not a new export, so that pair is dropped. */
function introducedExports(content: string, preContent: string): Map<number, string> {
	const before = valueExports(preContent);
	const after = valueExports(content);
	const renamed = removedShapes(preContent, after);
	const lines = content.split("\n");
	const out = new Map<number, string>();
	for (const [name, line] of after) {
		if (before.has(name) || renamed.has(declarationShape(lines, line, name))) continue;
		out.set(line, name);
	}
	return out;
}

/** Same files, but every read is served once — the two scans below share it. */
function memoRepo(repo: DeadExportsRepo): DeadExportsRepo {
	const cache = new Map<string, string | null>();
	return {
		listFiles: repo.listFiles,
		readFile: (rel) => {
			const hit = cache.get(rel);
			if (hit !== undefined) return hit;
			const read = repo.readFile(rel);
			cache.set(rel, read);
			return read;
		},
	};
}

/** The repo with test files removed as consumers: tests reaching a helper
 *  directly is the smell, so a test-only importer must not count as use.
 *  Strict predicate on purpose — `isTestFile` is the pattern-data alias that
 *  also names this package's own detector modules, which are production
 *  consumers, not tests. */
function withoutTestImporters(repo: DeadExportsRepo): DeadExportsRepo {
	return {
		listFiles: () => repo.listFiles().filter((f) => !isTestSourcePath(f)),
		readFile: repo.readFile,
	};
}

function describeNewExport(name: string, testOnly: boolean): string {
	const who = testOnly ? "is imported only by tests" : "has no importer";
	return `new export '${name}' ${who} — keep it module-private and test through the caller, unless it is a reusable seam (then add a 'public API' comment above it)`;
}

/**
 * Core detector over an injectable repo view. Reuses `findDeadExports` for
 * the importer scan (extension-blind resolution, barrels, the evidence guard,
 * the 'public API' escape) and keeps only the findings on lines this edit
 * introduced.
 */
export function findNewExportsWithoutImporter(
	args: HelperHygieneArgs,
	repo: DeadExportsRepo,
): InlineMatch[] {
	if (args.preContent === null || isTestFile(args.filePath)) return [];
	const introduced = introducedExports(args.content, args.preContent);
	if (introduced.size === 0) return [];

	const shared = memoRepo(repo);
	// `only` names the introduced exports so the dead-exports cap counts them
	// alone — a file already carrying ten dead exports cannot hide the new one.
	const deadArgs: DeadExportsArgs = {
		content: args.content,
		filePath: args.filePath,
		only: new Set(introduced.values()),
	};
	if (args.cwd !== undefined) deadArgs.cwd = args.cwd;
	const unusedByProd = findDeadExports(deadArgs, withoutTestImporters(shared)).filter((m) =>
		introduced.has(m.line),
	);
	if (unusedByProd.length === 0) return [];
	const unusedByAll = new Set(findDeadExports(deadArgs, shared).map((m) => m.line));

	return unusedByProd.map((m) => ({
		line: m.line,
		text: describeNewExport(introduced.get(m.line) ?? "", !unusedByAll.has(m.line)),
	}));
}

// ===========================================
// extracted_helper_duplicate
// ===========================================

function preExistingFunctionNames(preContent: string | null, filePath: string): Set<string> {
	if (preContent === null) return new Set();
	return new Set(computeCyclomaticComplexity(preContent, filePath).map((f) => f.name));
}

/** A body this close to verbatim is a copy, not an edited near-copy. */
const MOVE_SIMILARITY_THRESHOLD = 0.99;

interface DuplicateHit {
	name: string;
	line: number;
	otherName: string;
	otherFile: string;
	otherLine: number;
	similarity: number;
}

/** Sibling files live in the same directory (`collectSiblingFunctions` only
 *  ever scans that far), so this also holds for injected test candidates. */
function sameDirectory(a: string, b: string): boolean {
	return dirname(a) === dirname(b);
}

/** The exporter-first MOVE flow: a brand-new module (no on-disk baseline yet
 *  — nothing else CAN explain a fresh file already holding a sibling's
 *  function), or a same-directory sibling copy close enough to verbatim that
 *  it reads as "not yet deleted from the original" rather than "rewritten
 *  here". Below the verbatim bar, it is a genuine re-extraction instead. */
function isMoveInProgress(args: HelperHygieneArgs, f: DuplicateHit): boolean {
	if (args.preContent === null) return true;
	return f.similarity >= MOVE_SIMILARITY_THRESHOLD && sameDirectory(args.filePath, f.otherFile);
}

function siblingLabel(args: HelperHygieneArgs, otherFile: string): string {
	return isAbsolute(otherFile) ? relative(dirname(args.filePath), otherFile) : otherFile;
}

function describeDuplicate(args: HelperHygieneArgs, f: DuplicateHit): string {
	const where = siblingLabel(args, f.otherFile);
	const pct = Math.round(f.similarity * 100);
	return `${f.name}() already exists as ${f.otherName}() in ${where}:${f.otherLine} (${pct}% similar) — import it instead of extracting a second copy`;
}

/** One finding per sibling file, not per moved function: an exporter-first
 *  move typically carries several functions across in one edit, and five
 *  near-identical "import it instead" findings would all say the same thing. */
function describeMoveGroup(args: HelperHygieneArgs, otherFile: string, hits: DuplicateHit[]): InlineMatch {
	const where = siblingLabel(args, otherFile);
	const line = Math.min(...hits.map((h) => h.line));
	return {
		line,
		text: `move in progress: ${hits.length} function(s) byte-identical to ${where}; delete the originals from ${where} in the next edit (or import them from here)`,
	};
}

function groupMoveFindings(args: HelperHygieneArgs, hits: DuplicateHit[]): InlineMatch[] {
	const byFile = new Map<string, DuplicateHit[]>();
	for (const hit of hits) {
		const group = byFile.get(hit.otherFile) ?? [];
		group.push(hit);
		byFile.set(hit.otherFile, group);
	}
	return Array.from(byFile.entries()).map(([otherFile, group]) => describeMoveGroup(args, otherFile, group));
}

/**
 * Core detector. `candidates` is a thunk so the sibling scan is only paid when
 * the edit actually introduces a comparable function. Each new function is
 * matched on its own against foreign candidates only (its single best match),
 * so a same-file twin can never shadow the cross-file match.
 */
export function findExtractedHelperDuplicates(
	args: HelperHygieneArgs,
	candidates: () => FunctionShingles[],
): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(args.filePath)) || isTestFile(args.filePath)) return [];
	const existing = preExistingFunctionNames(args.preContent, args.filePath);
	const introduced = extractFunctionShingles(args.content, args.filePath).filter(
		(f) => f.shingles.size > 0 && !existing.has(f.name),
	);
	if (introduced.length === 0) return [];

	const foreign = candidates().filter((c) => c.file !== args.filePath);
	if (foreign.length === 0) return [];

	const hits = findClones({
		edited: introduced,
		candidates: foreign,
		threshold: HELPER_DUPLICATE_THRESHOLD,
	});
	if (hits.length === 0) return [];

	const moves: DuplicateHit[] = [];
	const extractions: DuplicateHit[] = [];
	for (const hit of hits) (isMoveInProgress(args, hit) ? moves : extractions).push(hit);

	return [
		...extractions.map((hit) => ({ line: hit.line, text: describeDuplicate(args, hit) })),
		...groupMoveFindings(args, moves),
	];
}

// ===========================================
// Registry-facing wrappers — disk-backed pre-edit content
// ===========================================

function readPreContent(absPath: string): string | null {
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		// Missing or unreadable: treat as a new file (the exempt case).
		return null;
	}
}

/** Real repo view: git file listing + filesystem reads. */
function liveRepo(cwd: string): DeadExportsRepo {
	return {
		listFiles: () => getGitSourceFiles(cwd),
		readFile: (rel) => readPreContent(resolve(cwd, rel)),
	};
}

/** Registry-facing wrapper for `new_export_without_importer`. */
export function checkNewExportWithoutImporter(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	return findNewExportsWithoutImporter(
		{ content, filePath, cwd, preContent: readPreContent(abs) },
		liveRepo(cwd),
	);
}

/** Registry-facing wrapper for `extracted_helper_duplicate`. */
export function checkExtractedHelperDuplicate(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	return findExtractedHelperDuplicates(
		{ content, filePath: abs, preContent: readPreContent(abs) },
		() => collectSiblingFunctions(abs),
	);
}
