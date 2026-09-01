// ===========================================
// Edit doom analysis — LG-1/LG-2 (docs/design/edit-contract-hardening.md)
// ===========================================
//
// Deterministic detection of edits the client itself is about to reject,
// mirroring the client's own failure semantics exactly:
//   - Edit / MultiEdit entry whose old_string is absent          → doomed
//   - Edit / MultiEdit entry matching >1× without replace_all    → doomed
//   - apply_patch Update hunk whose context can't be matched     → warn-tier
//     (Codex's matcher has leniency we don't fully model — see the memo;
//     promotes to block only on measured FP≈0 via recurrence counts)
//
// A doom block is strictly better than letting the call fail: the reason
// carries the rescue material (verbatim current content of the best-matching
// span) so the retry succeeds in ONE round trip, with no re-read.
//
// Fail-open discipline: any fs error, missing file, or unrecognized input
// shape returns null / [] — the client remains the authority on every case
// we cannot decide with certainty.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	extractApplyPatchRaw,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "../apply-patch-content.js";
import {
	countOccurrences,
	findClosestSpans,
	findOccurrenceLines,
	formatRescue,
	suggestUniqueAnchor,
} from "../edit-diagnostics.js";
import type { HarnessEvent } from "../types.js";

type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

const DOOM_NEAR_MISS_MATCHES = 3;
const MULTI_MATCH_SITE_CAP = 5;
const APPLY_PATCH_WARNING_CAP = 3;

/** One str-replace entry (a bare Edit, or one element of MultiEdit's edits[]). */
interface ReplaceEntry {
	oldString: string;
	newString: string;
	replaceAll: boolean;
}

export interface EditDoom {
	kind: "missing" | "ambiguous";
	filePath: string;
	oldString: string;
	/** 1-based entry position and total (1/1 for a bare Edit). */
	entryIndex: number;
	entryCount: number;
	/** File content at the moment of doom (post earlier simulated entries). */
	content: string;
	/** Occurrence start lines (ambiguous kind only). */
	occurrenceLines: number[];
}

/** Parse the tool input into simulate-able entries, or null on foreign shapes. */
function replaceEntries(toolInput: ToolInput): ReplaceEntry[] | null {
	if (typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
		return [
			{
				oldString: toolInput.old_string,
				newString: toolInput.new_string,
				replaceAll: toolInput.replace_all === true,
			},
		];
	}
	if (!Array.isArray(toolInput.edits)) return null;
	const rawEdits: unknown[] = toolInput.edits;
	const entries: ReplaceEntry[] = [];
	for (const edit of rawEdits) {
		if (!edit || typeof edit !== "object") return null;
		const bag = edit as Record<string, unknown>;
		if (typeof bag.old_string !== "string" || typeof bag.new_string !== "string") return null;
		entries.push({
			oldString: bag.old_string,
			newString: bag.new_string,
			replaceAll: bag.replace_all === true,
		});
	}
	return entries.length > 0 ? entries : null;
}

/** Apply one entry to the simulated content (first-occurrence or all). */
function applyEntry(content: string, entry: ReplaceEntry): string {
	if (entry.replaceAll) return content.split(entry.oldString).join(entry.newString);
	return content.replace(entry.oldString, entry.newString);
}

/**
 * Sequentially simulate Edit/MultiEdit entries against the live file and
 * return the first doomed entry, or null when every entry would apply (or
 * when the input/file is out of scope — fail open).
 */
export function analyzeStrReplaceDoom(toolName: string, toolInput: ToolInput): EditDoom | null {
	if (toolName !== "Edit" && toolName !== "MultiEdit") return null;
	const filePath = toolInput.file_path;
	if (typeof filePath !== "string" || filePath.length === 0) return null;
	const entries = replaceEntries(toolInput);
	if (!entries) return null;
	let content: string;
	try {
		if (!existsSync(filePath)) return null;
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	for (const [i, entry] of entries.entries()) {
		const occurrences = countOccurrences(content, entry.oldString);
		if (occurrences === 0) {
			return {
				kind: "missing",
				filePath,
				oldString: entry.oldString,
				entryIndex: i + 1,
				entryCount: entries.length,
				content,
				occurrenceLines: [],
			};
		}
		if (occurrences > 1 && !entry.replaceAll) {
			return {
				kind: "ambiguous",
				filePath,
				oldString: entry.oldString,
				entryIndex: i + 1,
				entryCount: entries.length,
				content,
				occurrenceLines: findOccurrenceLines(content, entry.oldString),
			};
		}
		content = applyEntry(content, entry);
	}
	return null;
}

/** "entry 3 of 5 " prefix for MultiEdit dooms; empty for a bare Edit. */
function entryPrefix(doom: EditDoom): string {
	return doom.entryCount > 1 ? `entry ${doom.entryIndex} of ${doom.entryCount}: ` : "";
}

/** The atomicity note MultiEdit dooms carry (per-entry accounting). */
function atomicityNote(doom: EditDoom): string {
	if (doom.entryCount <= 1) return "";
	const applied =
		doom.entryIndex > 1
			? `Entries 1–${doom.entryIndex - 1} would have applied, but MultiEdit is atomic — nothing was applied. `
			: "MultiEdit is atomic — nothing was applied. ";
	return `${applied}Re-issue the full call with this entry fixed.\n`;
}

function formatMissingReason(doom: EditDoom): string {
	const misses = findClosestSpans(doom.content, doom.oldString, DOOM_NEAR_MISS_MATCHES);
	const rescue = misses.length > 0 ? `\n${formatRescue(misses, doom.oldString)}` : "";
	const simNote =
		doom.entryCount > 1 && doom.entryIndex > 1
			? " (checked against the file with earlier entries applied)"
			: "";
	return (
		`Edit will fail: ${entryPrefix(doom)}old_string not found in ${doom.filePath}${simNote}. ` +
		`The file content differs from what this edit expected.\n${atomicityNote(doom)}${rescue}`.trimEnd()
	);
}

function formatAmbiguousReason(doom: EditDoom): string {
	const sites = doom.occurrenceLines.slice(0, MULTI_MATCH_SITE_CAP);
	const extra = doom.occurrenceLines.length - sites.length;
	const siteList = sites.map((l) => `L${l}`).join(", ") + (extra > 0 ? ` (+${extra} more)` : "");
	const anchor = suggestUniqueAnchor(doom.content, doom.oldString);
	const anchorHint = anchor
		? `\nA unique anchor exists — use this as old_string instead:\n\`\`\`\n${anchor}\n\`\`\``
		: "";
	return (
		`Edit will fail: ${entryPrefix(doom)}old_string matches ${doom.occurrenceLines.length} times in ${doom.filePath} ` +
		`(${siteList}) and replace_all is not set. Either pass replace_all: true to change every site, ` +
		`or widen old_string until it is unique.\n${atomicityNote(doom)}${anchorHint}`.trimEnd()
	);
}

/** The full block reason for a doomed Edit/MultiEdit, rescue material included. */
export function formatDoomReason(doom: EditDoom): string {
	return doom.kind === "missing" ? formatMissingReason(doom) : formatAmbiguousReason(doom);
}

/** Resolve an apply_patch section path against the daemon's project root. */
function resolveSectionPath(path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}

/** One warn-tier apply_patch finding, path kept separate for recurrence rows. */
interface ApplyPatchDoom {
	path: string;
	warning: string;
}

/**
 * Warn-tier apply_patch context validation (Codex sessions): parse the patch,
 * reconstruct each Update section against the live file, and warn when the
 * reconstruction bails — its context lines don't match the file (or the hunk
 * is ambiguous), which is exactly when Codex's own apply fails. Warnings are
 * capped; every uncertain case stays silent.
 */
export function analyzeApplyPatchDoom(toolName: string, toolInput: ToolInput): ApplyPatchDoom[] {
	if (toolName !== "apply_patch") return [];
	const raw = extractApplyPatchRaw(toolInput);
	if (!raw) return [];
	const dooms: ApplyPatchDoom[] = [];
	for (const section of parseApplyPatchSections(raw)) {
		if (dooms.length >= APPLY_PATCH_WARNING_CAP) break;
		if (section.op !== "update") continue;
		const abs = resolveSectionPath(section.fromPath ?? section.path);
		let before: string;
		try {
			if (!existsSync(abs)) {
				dooms.push({
					path: section.path,
					warning: `[interlinked:apply-patch-doom][heuristic] Update section targets ${section.path}, which does not exist — apply_patch will likely fail. Re-check the path (or use an Add File section).`,
				});
				continue;
			}
			before = readFileSync(abs, "utf-8");
		} catch {
			continue;
		}
		if (reconstructAfterContent(section, before) === null) {
			const misses = findClosestSpans(before, firstOldBlock(section.body), DOOM_NEAR_MISS_MATCHES);
			const rescue = misses.length > 0 ? `\n${formatRescue(misses, firstOldBlock(section.body))}` : "";
			dooms.push({
				path: section.path,
				warning: `[interlinked:apply-patch-doom][heuristic] The hunk context for ${section.path} does not match the live file (or is ambiguous) — apply_patch will likely fail. Re-read the file and rebuild the hunk from current content.${rescue}`,
			});
		}
	}
	return dooms;
}

/** The first hunk's old-side (context + deletions) — the anchor text the patch
 *  expects to find; drives near-miss rescue for a mismatched section. */
function firstOldBlock(body: string[]): string {
	const oldLines: string[] = [];
	for (const line of body) {
		if (line.startsWith("@@") && oldLines.length > 0) break;
		if (line.startsWith("-") || line.startsWith(" ")) oldLines.push(line.slice(1));
		else if (line === "" && oldLines.length > 0) oldLines.push("");
	}
	return oldLines.join("\n");
}
