// ===========================================
// Per-edit coverage — edit-target resolution
// ===========================================
// Resolves the set of CODE FILES a write touches, with the proposed post-edit
// content and the added-line set for each, so the coverage gate
// (`coverage-write-guard.ts`) can evaluate every one of them. Split out so the
// gate module stays under the per-file line cap and so the apply_patch path —
// the multi-file, payload-embedded case (finding 1) — is unit-testable on its own.
//
// Two write shapes, one resolver:
//   - `apply_patch` (Codex/Copilot): the path(s) live inside the V4A patch body,
//     never in `file_path`, and a single payload can touch MANY files. Each
//     section's post-edit content is reconstructed with the SAME applier the
//     cyclomatic gate uses (`reconstructAfterContent`); a section that can't be
//     applied with certainty is skipped (fail-open per file, never a false block).
//   - every other write (Write/Edit/MultiEdit/str_replace/create): the single
//     file named in `file_path` / `path`.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import {
	type ApplyPatchSection,
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "../apply-patch-content.js";
import type { OverlayFile } from "../coverage-overlay.js";
import { type CoverageLanguage, coverageLanguageForPath } from "../coverage-runner.js";
import { isTestPath } from "../coverage-test-selector.js";
import { isCappableFile } from "../large-file-policy.js";
import { resolveProposedContent } from "../overlay-content.js";
import { deriveEditedLineNumbers } from "../server/edit-line-derivation.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";

/** One file the coverage gate will evaluate: its project-relative POSIX path, the
 *  coverage language, the proposed post-edit content, and the lines this edit
 *  added (for strict-TDD scoping; `undefined` ⇒ any uncovered line counts). */
export interface CoverageTarget {
	relPath: string;
	language: CoverageLanguage;
	proposed: string;
	editedLines: Set<number> | undefined;
}

type PerEditCfg = NonNullable<GuardRulesConfig["per_edit_coverage"]>;

/**
 * A raw (absolute or cwd-relative) path as a project-relative POSIX path, or null
 * when it falls outside the project. Path-traversal safe (finding, 2026-06): the
 * path is RESOLVED (normalizing any `../`) before confinement, because an
 * apply_patch payload is agent-controlled and `*** Update File: ../../victim.ts`
 * produces `${projectRoot}/../../victim.ts`, which string-`startsWith` the root yet
 * escapes it — the overlay would then join + write outside the project. `relative`
 * yields a `..`-prefixed or absolute path for anything outside the root, which we
 * reject (along with the root itself).
 */
function toProjectRel(raw: string, projectRoot: string): string | null {
	if (!raw) return null;
	const root = resolve(projectRoot);
	const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
	const rel = relative(root, abs);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.replace(/\\/g, "/");
}

/** Resolve the edited file path from the tool input (absolute or cwd-relative). */
function editedRelPath(event: HarnessEvent, projectRoot: string): string | null {
	const input = event.tool_input ?? {};
	const raw = (input.file_path as string) || (input.path as string) || "";
	return toProjectRel(raw, projectRoot);
}

/** Read a file's current content, or "" when missing/unreadable — the "before" an
 *  apply_patch section is reconstructed against. */
function safeReadFile(abs: string): string {
	try {
		return existsSync(abs) ? readFileSync(abs, "utf-8") : "";
	} catch {
		return "";
	}
}

/** Cap on the LCS diff's O(n·m) work; beyond it every after-line is treated as
 *  edited (the strict direction — this never UNDER-counts an inserted line). */
const LCS_CELL_BUDGET = 4_000_000;

/**
 * The 1-indexed line numbers in `after` that this edit ADDED/CHANGED versus
 * `before`, by a POSITIONAL line diff (LCS) rather than a content bag. The bag
 * lost positional identity (finding 2026-06): inserting a line equal to a later
 * existing line let the insertion "consume" the old line's bag count and marked
 * the SHIFTED old line as edited instead — so a genuinely-new uncovered line could
 * be excluded from editedLines and pass the per-line coverage check on the first
 * baseline run. LCS aligns by position AND content, so each truly-inserted line is
 * identified exactly. Beyond `LCS_CELL_BUDGET` it falls back to "every after-line
 * edited" (strict — safe direction).
 */
/** Fill row `i` of the LCS `dp` table from the already-computed row `i + 1`. */
function fillLcsDpRow(i: number, a: string[], b: string[], dp: number[][]): void {
	for (let j = b.length - 1; j >= 0; j--) {
		nonNull(dp[i])[j] =
			a[i] === b[j]
				? nonNull(nonNull(dp[i + 1])[j + 1]) + 1
				: Math.max(nonNull(nonNull(dp[i + 1])[j]), nonNull(nonNull(dp[i])[j + 1]));
	}
}

function addedLineNumbers(before: string, after: string): Set<number> {
	const a = before.split("\n");
	const b = after.split("\n");
	const n = a.length;
	const m = b.length;
	if (n * m > LCS_CELL_BUDGET) {
		const all = new Set<number>();
		for (let k = 1; k <= m; k++) all.add(k);
		return all;
	}
	// dp[i][j] = LCS length of a[i:] and b[j:].
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		fillLcsDpRow(i, a, b, dp);
	}
	// Walk the alignment: an after-line with no matching before-line is inserted.
	const edited = new Set<number>();
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			i++;
			j++;
		} else if (nonNull(nonNull(dp[i + 1])[j]) >= nonNull(nonNull(dp[i])[j + 1])) {
			i++; // a[i] deleted — absent from `after`
		} else {
			edited.add(j + 1); // b[j] inserted / changed
			j++;
		}
	}
	while (j < m) {
		edited.add(j + 1); // trailing inserted after-lines
		j++;
	}
	return edited;
}

/** The CONFINED source path of a MOVED section (its pre-Move `fromPath`), or null when
 *  the section was not moved or the source path escapes the project root. */
function moveSourceRel(section: ApplyPatchSection, projectRoot: string): string | null {
	return section.fromPath ? toProjectRel(section.fromPath, projectRoot) : null;
}

/** Build the coverage target for one reconstructed apply_patch section, or null to
 *  skip it (wrong language, out of tree, unreconstructable, or non-cappable). */
function targetForSection(
	section: ApplyPatchSection,
	projectRoot: string,
	cfg: PerEditCfg,
): CoverageTarget | null {
	if (section.op === "delete") return null; // a deleted file is not a coverage target
	const language = coverageLanguageForPath(section.path);
	if (!language || !cfg.languages.includes(language)) return null;
	const relPath = toProjectRel(section.path, projectRoot);
	if (relPath === null) return null;
	// Read before-content from the SOURCE path for a moved section (finding 2026-06:
	// reading the destination, which doesn't exist yet, mis-reconstructed the move).
	// Confined relPath only — a rejected traversal can't reach the filesystem here.
	const beforeRel = moveSourceRel(section, projectRoot) ?? relPath;
	const before = safeReadFile(resolve(projectRoot, beforeRel));
	const after = reconstructAfterContent(section, before);
	if (after === null) return null; // can't reconstruct confidently → fail open here
	if (!isCappableFile({ filePath: relPath, content: after })) return null;
	return { relPath, language, proposed: after, editedLines: addedLineNumbers(before, after) };
}

/**
 * Coverage targets for a Codex/Copilot `apply_patch` payload — one per code file
 * the patch touches (finding 1), built from the ALREADY-PARSED section list so
 * the payload is parsed exactly once per event.
 */
function applyPatchCoverageTargets(
	sections: ApplyPatchSection[],
	projectRoot: string,
	cfg: PerEditCfg,
): CoverageTarget[] {
	const targets: CoverageTarget[] = [];
	for (const section of sections) {
		const target = targetForSection(section, projectRoot, cfg);
		if (target) targets.push(target);
	}
	return targets;
}

/** Single-file (Write/Edit/MultiEdit/str_replace/create) coverage target, or []. */
function singleFileTargets(
	event: HarnessEvent,
	projectRoot: string,
	cfg: PerEditCfg,
): CoverageTarget[] {
	const input = event.tool_input ?? {};
	const relPath = editedRelPath(event, projectRoot);
	if (!relPath) return [];
	const language = coverageLanguageForPath(relPath);
	if (!language || !cfg.languages.includes(language)) return [];
	const proposed = resolveProposedContent(`${projectRoot}/${relPath}`, input);
	if (!isCappableFile({ filePath: relPath, content: proposed })) return [];
	return [
		{ relPath, language, proposed, editedLines: deriveEditedLineNumbers(event.tool_name, input, proposed) },
	];
}

/**
 * EVERY file an apply_patch materializes — reconstructed + confined, INCLUDING test
 * and non-code sections (which are not coverage TARGETS but MUST be in the overlay
 * so a code+test patch's suite actually covers the code instead of false-blocking —
 * finding 2026-06). Skips sections that can't be confined/reconstructed.
 */
function applyPatchOverlayFiles(
	sections: ApplyPatchSection[],
	projectRoot: string,
): OverlayFile[] {
	const files: OverlayFile[] = [];
	for (const section of sections) {
		const relPath = toProjectRel(section.path, projectRoot);
		if (relPath === null) continue;
		// A Delete REMOVES the file from the overlay so the suite sees it ABSENT, not
		// as an empty module (finding 2026-06: it was written as "").
		if (section.op === "delete") {
			files.push({ relPath, content: "", delete: true });
			continue;
		}
		// Read before-content from the SOURCE (pre-Move) path so a move's hunks
		// reconstruct against the right contents (finding 2026-06).
		const fromRel = moveSourceRel(section, projectRoot);
		const after = reconstructAfterContent(section, safeReadFile(resolve(projectRoot, fromRel ?? relPath)));
		if (after === null) continue;
		files.push({ relPath, content: after });
		// A Move ALSO removes the source file from the overlay (it no longer exists).
		if (fromRel !== null && fromRel !== relPath) {
			files.push({ relPath: fromRel, content: "", delete: true });
		}
	}
	return files;
}

/**
 * The reason this patch MUST run the FULL suite instead of a scoped affected-test
 * subset, or null when scoped selection is sound. Scoping draws its subset from
 * the ON-DISK dependency graph, so it is only sound when every section is an
 * in-place UPDATE of an existing non-test file (the graph already models those).
 * It is forced full for:
 *   - a TEST section (added OR updated, incl. a move source/destination): the
 *     patch's own tests live in the overlay, not the on-disk graph, so a scoped
 *     subset would never execute them — the red-green/TDD signal would be lost;
 *   - a DELETE: the deleted file is not a coverage target, so no per-target
 *     selection ever runs its dependents' tests — only the full suite sees the
 *     breakage;
 *   - a MOVE: same blast-radius blindness as a delete for the vacated source path.
 * A routine source-only patch returns null and stays on the scoped route
 * (finding 2026-06: blanket full-suite forcing made every patch defer to the
 * commit gate on big-suite repos even when affected tests were selectable). An
 * ADDED source file needs no plan-level forcing: it is not in the graph, so its
 * own target already falls back to the full suite per-file, while sibling update
 * targets keep their sound scoped runs.
 */
function patchFullSuiteReason(sections: ApplyPatchSection[]): string | null {
	for (const section of sections) {
		if (isTestPath(section.path) || (section.fromPath && isTestPath(section.fromPath))) {
			return `the patch touches test file ${section.path} — a scoped subset drawn from the on-disk graph would not run it`;
		}
		if (section.op === "delete") {
			return `the patch deletes ${section.path} — its dependents' tests are outside any scoped subset`;
		}
		if (section.fromPath) {
			return `the patch moves ${section.fromPath} — its dependents' tests are outside any scoped subset`;
		}
	}
	return null;
}

/** The full plan for a write: production files to GATE (`targets`), ALL files to
 *  MATERIALIZE in the overlay (`overlayFiles` ⊇ targets — adds the patch's tests
 *  and siblings), and whether/why the FULL suite is required. */
export interface CoverageEditPlan {
	targets: CoverageTarget[];
	overlayFiles: OverlayFile[];
	/** True for a recognized apply_patch payload (multi-section write shape). */
	isPatch: boolean;
	/** Non-null ⇒ scoped affected-test selection would be UNSOUND for this write
	 *  and the caller must run the FULL suite, with the human-readable reason why
	 *  (see {@link patchFullSuiteReason}). Null ⇒ the scoped route is sound. */
	fullSuiteReason: string | null;
}

export function coverageEditPlan(
	event: HarnessEvent,
	projectRoot: string,
	cfg: PerEditCfg,
): CoverageEditPlan {
	const input = event.tool_input ?? {};
	const raw = extractApplyPatchRaw(input);
	if (raw && looksLikeApplyPatch(raw)) {
		// Parse the payload ONCE; targets, overlay files, and the full-suite verdict
		// are all derived from the same section list.
		const sections = parseApplyPatchSections(raw);
		return {
			targets: applyPatchCoverageTargets(sections, projectRoot, cfg),
			overlayFiles: applyPatchOverlayFiles(sections, projectRoot),
			isPatch: true,
			fullSuiteReason: patchFullSuiteReason(sections),
		};
	}
	const targets = singleFileTargets(event, projectRoot, cfg);
	return {
		targets,
		overlayFiles: targets.map((t) => ({ relPath: t.relPath, content: t.proposed })),
		isPatch: false,
		fullSuiteReason: null,
	};
}

/**
 * Every code file this write touches, as coverage targets — a back-compat wrapper
 * over {@link coverageEditPlan}. `apply_patch` yields one target per reconstructed
 * code section; every other write shape yields the single file named in `file_path`.
 */
export function coverageTargetsFor(
	event: HarnessEvent,
	projectRoot: string,
	cfg: PerEditCfg,
): CoverageTarget[] {
	return coverageEditPlan(event, projectRoot, cfg).targets;
}
