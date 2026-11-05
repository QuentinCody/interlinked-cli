// ===========================================
// Kill proof — the prove-kill command a surface prints for a test file
// ===========================================
// The PostToolUse nudge (`evaluator/post-tool-kill-proof.ts`) and the Stop check
// (`mutation-kill-evidence-stop-check.ts`) both tell the agent how to produce
// executed evidence for a mutation-directed test file. When the manifest's
// survivors SIDECAR knows more than one survivor of the file's companion source,
// the batch form (`--all-survivors`) proves them all in one command with one
// shared baseline; otherwise the single-mutant form stands. The sidecar is the
// daemon's read model (hundreds of KB, mtime-cached), never the manifest; a
// missing or unreadable sidecar keeps the single form. Naming is a discovery
// aid for the COMMAND only — it decides nothing about evidence.

import { basename, dirname } from "node:path";
import { MUTATION_DIRECTED_SUFFIX } from "../checks/test-legitimacy.js";
import { loadSurvivorsIndex } from "../mutation/survivors-index.js";

const TEST_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** `src/a.mutation-kill.test.ts` → `src/a.ts`, `src/a.tsx`, … in that order; empty for a path that is not a JS/TS test file. */
export function companionSourceCandidates(testRelPath: string): string[] {
	const posix = testRelPath.replace(/\\/g, "/");
	const name = basename(posix);
	const stripped = name.replace(TEST_SUFFIX, "");
	if (stripped === name) return [];
	const base = stripped.replace(MUTATION_DIRECTED_SUFFIX, "");
	const dir = dirname(posix);
	return SOURCE_EXTS.map(ext => (dir === "." ? `${base}${ext}` : `${dir}/${base}${ext}`));
}

export interface KnownSurvivors {
	/** Manifest key of the companion source the sidecar knows. */
	source: string;
	/** Survivors the sidecar lists for it (dispositioned ones included: the mechanical count). */
	count: number;
}

export type SurvivorsLookup = (root: string, testRelPath: string) => KnownSurvivors | null;

/** The sidecar's survivor count for the first companion source it knows; null when it knows none or is absent. */
export const knownSurvivorsFor: SurvivorsLookup = (root, testRelPath) => {
	const index = loadSurvivorsIndex(`${root}/.interlinked`);
	if (index === null) return null;
	for (const candidate of companionSourceCandidates(testRelPath)) {
		const entry = index.files[candidate];
		if (entry !== undefined) return { source: candidate, count: entry.survivors.length };
	}
	return null;
};

/** The batch form needs more than one survivor to pay for itself; one or none keeps the single-mutant form. */
export function prefersBatch(known: KnownSurvivors | null): known is KnownSurvivors {
	return known !== null && known.count > 1;
}

/** The command to print for `testRelPath`: `--all-survivors` over the companion source when several survivors are known, else `--mutant <id>`. */
export function proveKillCommandFor(testRelPath: string, known: KnownSurvivors | null): string {
	if (prefersBatch(known)) return `interlinked tests prove-kill --file ${known.source} --test ${testRelPath} --all-survivors`;
	return `interlinked tests prove-kill --mutant <id> --test ${testRelPath}`;
}
