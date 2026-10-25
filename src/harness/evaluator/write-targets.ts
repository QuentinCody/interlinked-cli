// ===========================================
// Write targets — which files a tool call writes, and what it leaves there
// ===========================================
//
// Shared by the PreToolUse content gates that judge a water-line by its
// proposed bytes (baseline integrity, config loosening). Red team 2026-10-21
// round 3 ("write classification") found three ways a write reached a
// water-line without being judged, all upstream of the detectors:
//
//   1. Tool-name classification: each gate kept a private "is this a write"
//      list that missed runner spellings the repository already knew
//      (OpenCode `edit` / `write`, Gemini `replace`, `Update`, `notebook_edit`,
//      `file_edit`, VS Code `create_file` / `replace_string_in_file`,
//      `ApplyPatch`). The ONE classifier is now `isWriteCapableToolName` in
//      `lib/write-tool-registry.ts`, which compares normalized names.
//   2. Path classification before resolution: `metric-caps.json` from a cwd
//      of `<repo>/.interlinked`, or `~/repo/.interlinked/…`, was classified as
//      spelled and missed. Every path is resolved first (`resolveTargetPaths`).
//   3. A V4A patch sent through a shell (`apply_patch <<'EOF' … EOF`, the
//      spelling Codex routes to its patch engine) was never parsed. Any tool
//      whose patch-shaped field carries a patch is now judged as a patch.
//
// A target whose result cannot be reconstructed is returned UNDECIDABLE, so
// the caller fails closed. Disk access is injected (`ReadDisk`).

import { homedir } from "node:os";
import { isAbsolute, posix, resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { isWriteCapableToolName } from "../../lib/write-tool-registry.js";
import { normalizeToolName } from "../adapters/normalization.js";
import {
	type ApplyPatchSection,
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "../apply-patch-content.js";
import { type Reconstruction, reconstructToolInput, undecidable } from "./edit-reconstruction.js";

/** One file a tool call targets. */
export interface WriteTarget {
	/** Absolute, normalized path the detectors judge. */
	filePath: string;
	/** Text on disk before the call; null when the file does not exist. */
	before: string | null;
	/** What the call would leave in the file. */
	proposed: Reconstruction;
}

/** Reads the current text of an absolute path; null when it does not exist. */
type ReadDisk = (absPath: string) => string | null;

const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath", "target_file", "notebookPath", "absolute_path", "file"] as const;
const PATCH_KEYS = ["patch", "command", "_raw_patch", "patchText", "input", "cmd"] as const;
const SHELL_DIR_KEYS = ["workdir", "cwd", "directory", "dir_path"] as const;
const PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "applypatch", "patch"]);
const DELETED = "";

/** Public API — the spelling the detectors key on (`./`, `..`, `//`, `\` collapsed). */
export function normalizeTargetPath(filePath: string): string {
	return posix.normalize(filePath.replace(/\\/g, "/"));
}

/**
 * Public API — every absolute path a tool-call path can reach, resolved
 * BEFORE classification. A relative path resolves against `cwd`. `~` and `~/…`
 * yield the home-expanded path (the reading of a client that expands it) AND
 * the literal relative one, so the gate judges both and never guesses.
 */
export function resolveTargetPaths(rawPath: string, cwd: string | undefined): string[] {
	const base = cwd ?? process.cwd();
	const literal = normalizeTargetPath(isAbsolute(rawPath) ? rawPath : resolve(base, rawPath));
	if (rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
		return [...new Set([normalizeTargetPath(resolve(homedir(), rawPath.slice(2))), literal])];
	}
	return [literal];
}

/** Lines of the first heredoc body in a shell command, or null when there is none. */
function heredocBody(command: string): string | null {
	const lines = command.split("\n");
	for (const [index, line] of lines.entries()) {
		const opener = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
		if (!opener) continue;
		const delimiter = opener[2] ?? "";
		const rest = lines.slice(index + 1);
		const end = rest.findIndex((l) => l.trim() === delimiter);
		return (end < 0 ? rest : rest.slice(0, end)).join("\n");
	}
	return null;
}

/** Strip leading `cd <dir> &&` hops, returning the directory they lead to. */
function leadingCdDir(command: string, cwd: string): { cwd: string; rest: string } {
	let dir = cwd;
	let rest = command;
	for (;;) {
		const hop = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&/.exec(rest);
		if (!hop) return { cwd: dir, rest };
		const target = (hop[1] ?? "").replace(/^(['"])(.*)\1$/, "$2");
		dir = resolveTargetPaths(target, dir)[0] ?? dir;
		rest = rest.slice(hop[0].length);
	}
}

/** One V4A patch a call carries, with the directory its section paths resolve against. */
interface PatchPayload {
	raw: string;
	cwd: string;
}

function stringsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function shellBaseDir(toolInput: JsonObject, cwd: string): string {
	for (const key of SHELL_DIR_KEYS) {
		const value = toolInput[key];
		if (typeof value === "string" && value.length > 0) return resolveTargetPaths(value, cwd)[0] ?? cwd;
	}
	return cwd;
}

/**
 * Public API — the V4A patch a call carries, or null when it carries none: the
 * apply_patch tool in any casing, or ANY tool whose patch-shaped field holds a
 * patch, including a shell command such as `cd pkg && apply_patch <<'EOF' … EOF`.
 * For a shell, the heredoc body is the patch and `workdir` / leading `cd`
 * hops set the directory its paths resolve against.
 */
export function patchPayloadOf(toolName: string, toolInput: JsonObject, cwd: string | undefined): PatchPayload | null {
	const base = cwd ?? process.cwd();
	if (PATCH_TOOLS.has(normalizeToolName(toolName))) {
		const raw = extractApplyPatchRaw(toolInput) || stringsOf(toolInput.patchText ?? toolInput.input).join("\n");
		if (raw) return { raw, cwd: base };
	}
	for (const key of PATCH_KEYS) {
		for (const value of stringsOf(toolInput[key])) {
			if (!looksLikeApplyPatch(value)) continue;
			const hop = leadingCdDir(value, shellBaseDir(toolInput, base));
			return { raw: heredocBody(hop.rest) ?? hop.rest, cwd: hop.cwd };
		}
	}
	return null;
}

/**
 * Public API — true when a content gate must look at this call: a direct
 * writer in any runner spelling (`isWriteCapableToolName`), or any tool that
 * carries a V4A patch (a shell heredoc included). A cheap routing pre-filter;
 * {@link toolWriteTargets} re-derives the targets itself.
 */
export function isContentWriteCandidate(toolName: string, toolInput: JsonObject | undefined): boolean {
	return isWriteCapableToolName(toolName) || patchPayloadOf(toolName, toolInput ?? {}, undefined) !== null;
}

/** The raw path values a write tool names (the registry decides which tools write). */
function explicitPaths(toolInput: JsonObject): string[] {
	const out: string[] = [];
	for (const key of PATH_KEYS) {
		const value = toolInput[key];
		if (typeof value === "string" && value.length > 0) out.push(value);
	}
	return out;
}

/** VS Code multi-replace carries the target path on each replacement. Group
 * entries by resolved file so repeated replacements see earlier edits. */
function replacementInputs(toolInput: JsonObject, cwd: string | undefined): Map<string, JsonObject[]> {
	const out = new Map<string, JsonObject[]>();
	if (!Array.isArray(toolInput.replacements)) return out;
	for (const entry of toolInput.replacements) {
		if (!isJsonObject(entry)) continue;
		const paths = new Set(explicitPaths(entry).flatMap((path) => resolveTargetPaths(path, cwd)));
		for (const path of paths) out.set(path, [...(out.get(path) ?? []), entry]);
	}
	return out;
}

/** Resolved paths a patch's directive lines name, including ones the section parser did not recognize. */
function directivePaths(raw: string, cwd: string): string[] {
	const out: string[] = [];
	for (const line of raw.split("\n")) {
		if (!/^\s*\*{3}/.test(line)) continue;
		for (const token of line.replace(/:/g, " ").split(/\s+/)) {
			if (token) out.push(...resolveTargetPaths(token, cwd));
		}
	}
	return out;
}

/** Per-path state while a patch's sections are applied in order. */
class PatchState {
	private readonly original = new Map<string, string | null>();
	private readonly current = new Map<string, string | null>();
	private readonly failed = new Map<string, string>();
	constructor(private readonly readDisk: ReadDisk) {}

	read(absPath: string): string | null {
		if (!this.current.has(absPath)) {
			const text = this.readDisk(absPath);
			this.original.set(absPath, text);
			this.current.set(absPath, text);
		}
		return this.current.get(absPath) ?? null;
	}

	write(absPath: string, text: string): void {
		this.read(absPath);
		this.current.set(absPath, text);
	}

	fail(absPath: string, reason: string): void {
		this.read(absPath);
		this.failed.set(absPath, reason);
	}

	target(absPath: string): WriteTarget {
		this.read(absPath);
		const reason = this.failed.get(absPath);
		return {
			filePath: absPath,
			before: this.original.get(absPath) ?? null,
			proposed: reason === undefined ? { kind: "decided", contents: [this.current.get(absPath) ?? DELETED] } : undecidable(reason),
		};
	}
}

/** Apply one section from `source` to `dest` (equal unless the section moves the file). */
function applySection(state: PatchState, section: ApplyPatchSection, source: string, dest: string): void {
	const before = state.read(source);
	const after = section.op === "update" && before === null ? null : reconstructAfterContent(section, before ?? DELETED);
	if (after === null) {
		const reason = `the apply_patch section for ${section.path} cannot be applied with certainty`;
		state.fail(source, reason);
		state.fail(dest, reason);
		return;
	}
	if (source !== dest) state.write(source, DELETED);
	state.write(dest, after);
}

/**
 * Apply a patch's sections in order and return every selected path it
 * touches. A selected path the patch names outside any parsable section is
 * returned UNDECIDABLE.
 */
function patchWriteTargets(
	payload: PatchPayload,
	toolInput: JsonObject,
	readDisk: ReadDisk,
	select: (absPath: string) => boolean,
): WriteTarget[] {
	const state = new PatchState(readDisk);
	const touched = new Set<string>();
	const resolveOne = (rawPath: string) => resolveTargetPaths(rawPath, payload.cwd);
	for (const section of parseApplyPatchSections(payload.raw)) {
		// `~/` sections resolve both ways; each reading is applied and judged.
		for (const [index, dest] of resolveOne(section.path).entries()) {
			const source = section.fromPath === undefined ? dest : (resolveOne(section.fromPath)[index] ?? dest);
			for (const p of [source, dest]) if (select(p)) touched.add(p);
			applySection(state, section, source, dest);
		}
	}
	const targets = [...touched].map((absPath) => state.target(absPath));
	const named = [...explicitPaths(toolInput).flatMap(resolveOne), ...directivePaths(payload.raw, payload.cwd)];
	for (const absPath of new Set(named)) {
		if (touched.has(absPath) || !select(absPath)) continue;
		touched.add(absPath);
		targets.push({
			filePath: absPath,
			before: readDisk(absPath),
			proposed: undecidable("the patch names this file outside any section the gate can parse"),
		});
	}
	return targets;
}

/**
 * Public API — every selected file a tool call writes, with its before-text
 * and reconstruction; empty when it writes none. A call is judged when it
 * carries a V4A patch (any tool, including a shell heredoc) or when the
 * registry classifies its name as a direct writer (`isWriteCapableToolName`).
 * Every path is resolved against `cwd` BEFORE `select` classifies it.
 */
export function toolWriteTargets(
	toolName: string,
	toolInput: JsonObject,
	cwd: string | undefined,
	readDisk: ReadDisk,
	select: (absPath: string) => boolean,
): WriteTarget[] {
	const patch = patchPayloadOf(toolName, toolInput, cwd);
	if (patch !== null) return patchWriteTargets(patch, toolInput, readDisk, select);
	if (!isWriteCapableToolName(toolName)) return [];
	const paths = new Set(explicitPaths(toolInput).flatMap((p) => resolveTargetPaths(p, cwd)));
	const targets = [...paths].filter(select).map((absPath) => {
		const before = readDisk(absPath);
		return { filePath: absPath, before, proposed: reconstructToolInput(before, toolInput) };
	});
	for (const [filePath, edits] of replacementInputs(toolInput, cwd)) {
		if (!select(filePath)) continue;
		const before = readDisk(filePath);
		targets.push({ filePath, before, proposed: reconstructToolInput(before, { edits }) });
	}
	return targets;
}
