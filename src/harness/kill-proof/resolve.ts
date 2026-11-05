// ===========================================
// Kill proof — pin the mutant to the current source bytes
// ===========================================
// A manifest survivor is re-located in the CURRENT source through
// `differential-fuzz-locate.ts`'s `locateMutantOffset` (identity.ts's own ordinal
// rule, never re-implemented here). Source that drifted so the identity no longer
// resolves is `unavailable`, not a guess. An explicit fault's anchor must occur
// exactly once (the plan 31 / requirement-faults rule).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTsModule } from "../mutation/differential-fuzz-deps.js";
import { locateMutantOffset } from "../mutation/differential-fuzz-locate.js";
import type { FuzzMutantTarget } from "../mutation/differential-fuzz-types.js";
import { loadManifestState } from "../mutation/manifest.js";
import type { MutantRecord, MutationManifest } from "../mutation/types.js";
import type { MutantSpec, ResolvedMutant } from "./types.js";

export type Resolved = { ok: true; mutant: ResolvedMutant } | { ok: false; reason: string };

interface ManifestHit {
	file: string;
	symbolId: string;
	qualifiedName: string;
	record: MutantRecord;
}

function findInManifest(manifest: MutationManifest, mutantId: string, file: string | undefined): ManifestHit | null {
	for (const [path, symbols] of Object.entries(manifest.files)) {
		if (file !== undefined && path !== file) continue;
		for (const [symbolId, symbol] of Object.entries(symbols)) {
			const record = symbol.mutants[mutantId];
			if (record) return { file: path, symbolId, qualifiedName: symbol.qualifiedName, record };
		}
	}
	return null;
}

/** The full source line that contains `offset`. */
export function lineTextAt(content: string, offset: number): string {
	const start = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const end = content.indexOf("\n", offset);
	return content.slice(start, end === -1 ? content.length : end);
}

export function lineOf(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
	return line;
}

function readSource(root: string, file: string): string | null {
	const abs = join(root, file);
	return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

function resolveFromManifest(root: string, spec: Extract<MutantSpec, { kind: "manifest" }>): Resolved {
	const state = loadManifestState(join(root, ".interlinked"));
	if (state.kind === "missing") {
		return { ok: false, reason: "no mutation manifest yet: run `interlinked mutation measure <file>`, or pass an explicit fault with --file/--find/--replace" };
	}
	if (state.kind === "corrupt") return { ok: false, reason: `mutation manifest is corrupt: ${state.detail}` };
	const hit = findInManifest(state.manifest, spec.mutantId, spec.file);
	if (hit === null) {
		const scope = spec.file ? ` in ${spec.file}` : "";
		return { ok: false, reason: `mutant ${spec.mutantId} is not in the mutation manifest${scope} (generation ${state.manifest.generation})` };
	}
	const content = readSource(root, hit.file);
	if (content === null) return { ok: false, reason: `${hit.file} does not exist in the working tree` };
	const ts = loadTsModule();
	if (ts === null) return { ok: false, reason: "typescript is not installed (optionalDependency); a manifest mutant cannot be re-located" };
	const target: FuzzMutantTarget = {
		file: hit.file,
		absPath: join(root, hit.file),
		qualifiedName: hit.qualifiedName,
		symbolId: hit.symbolId,
		mutantId: hit.record.mutantId,
		mutator: hit.record.mutator,
		originalLexeme: hit.record.originalLexeme,
		replacement: hit.record.replacement,
		ordinalWithinSymbol: hit.record.ordinalWithinSymbol,
	};
	const located = locateMutantOffset(ts, target, content);
	if (!located.ok) return { ok: false, reason: located.reason };
	return {
		ok: true,
		mutant: {
			file: hit.file,
			offset: located.offset,
			originalLexeme: hit.record.originalLexeme,
			replacement: hit.record.replacement,
			line: lineOf(content, located.offset),
			source: "manifest",
			mutantId: hit.record.mutantId,
			siteId: hit.record.siteId,
			symbolId: hit.symbolId,
			qualifiedName: hit.qualifiedName,
			mutator: hit.record.mutator,
			ordinalWithinSymbol: hit.record.ordinalWithinSymbol,
			manifestGeneration: state.manifest.generation,
			manifestStatus: hit.record.status,
		},
	};
}

function resolveExplicit(root: string, spec: Extract<MutantSpec, { kind: "explicit" }>): Resolved {
	if (spec.find.length === 0) return { ok: false, reason: "--find must not be empty" };
	if (spec.find === spec.replace) return { ok: false, reason: "--find and --replace are identical; nothing would change" };
	const content = readSource(root, spec.file);
	if (content === null) return { ok: false, reason: `${spec.file} does not exist in the working tree` };
	const occurrences = content.split(spec.find).length - 1;
	if (occurrences !== 1) return { ok: false, reason: `the --find text occurs ${occurrences} times in ${spec.file}; it must occur exactly once` };
	const offset = content.indexOf(spec.find);
	return {
		ok: true,
		mutant: { file: spec.file, offset, originalLexeme: spec.find, replacement: spec.replace, line: lineOf(content, offset), source: "explicit" },
	};
}

/** Pin `spec` to the current source bytes under `root`. Never throws for a user-shaped input. */
export function resolveMutant(root: string, spec: MutantSpec): Resolved {
	return spec.kind === "manifest" ? resolveFromManifest(root, spec) : resolveExplicit(root, spec);
}

/**
 * Re-locate a recorded mutant in the source bytes NOW on disk. Used by freshness
 * checks: the recorded offset must still hold the recorded lexeme, and a manifest
 * mutant must still resolve to that same offset by identity.
 */
export function relocate(root: string, mutant: ResolvedMutant): Resolved {
	if (mutant.source === "explicit") {
		return resolveExplicit(root, { kind: "explicit", file: mutant.file, find: mutant.originalLexeme, replace: mutant.replacement });
	}
	if (mutant.mutantId === undefined) return { ok: false, reason: "receipt carries a manifest mutant without a mutantId" };
	return resolveFromManifest(root, { kind: "manifest", mutantId: mutant.mutantId, file: mutant.file });
}
