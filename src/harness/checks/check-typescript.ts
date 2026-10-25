// ===========================================
// Check TypeScript — the `typescript` a registry detector parses with
// ===========================================
//
// Detectors that parse or type-check need the TypeScript compiler API at
// runtime. Bundling it into dist/ breaks esbuild's CJS-require helper, so the
// detectors load it with `node:module`'s `createRequire` (esbuild leaves that
// call alone) and keep only a type-only import at compile time.
//
// Resolution order:
//   1. The harness's OWN installation (`import.meta.url`), where `typescript`
//      is an optionalDependency.
//   2. The scanned project's copy, resolved from `checkRoot()` (see
//      check-root.ts). Resolving only from `process.cwd()` made a
//      `recurrence scan --cwd` of another tree read the caller's checkout.
//
// A success is cached: per process for the harness copy, per root for a
// project copy. A FAILURE is never cached. The next call tries again, so a
// `typescript` installed after the first miss is found, and a miss under one
// root does not hide the copy under another. When neither base resolves, the
// loader reports the standard `[interlinked:<check>] NOT MEASURED` line and
// returns null: the detector then returns [] and says so, never in silence.

import { createRequire } from "node:module";
import { join } from "node:path";
import type * as TS from "typescript";
import { checkRoot, reportNotMeasured } from "./check-root.js";

type TsModule = typeof TS;

let harnessTs: TsModule | null = null;
const projectTs = new Map<string, TsModule>();

/** `typescript` resolved from `base` (a file URL or path), or null. */
function requireTypescriptFrom(base: string): TsModule | null {
	try {
		// SAFETY: createRequire loads the installed TypeScript package selected by Node resolution; its exported compiler API matches the imported declarations.
		return createRequire(base)("typescript") as TsModule;
	} catch {
		return null;
	}
}

/** The harness's own `typescript`, else the check root's copy, else null. Caches successes only. */
function resolveTypescript(root: string): TsModule | null {
	harnessTs ??= requireTypescriptFrom(import.meta.url);
	if (harnessTs !== null) return harnessTs;
	const cached = projectTs.get(root);
	if (cached !== undefined) return cached;
	// The `_` entry is a non-existent sentinel file, so createRequire uses the
	// root directory as the resolution base.
	const fromProject = requireTypescriptFrom(join(root, "_"));
	if (fromProject !== null) projectTs.set(root, fromProject);
	return fromProject;
}

/**
 * The `typescript` compiler API for `checkId`, or null after a NOT MEASURED
 * report. `unmeasured` names what the skipped pass would have found, for the
 * disclosure line ("a cast between unrelated types").
 */
export function loadCheckTypescript(checkId: string, unmeasured: string): TsModule | null {
	const root = checkRoot();
	const ts = resolveTypescript(root);
	if (ts !== null) return ts;
	reportNotMeasured(
		checkId,
		`\`typescript\` is not resolvable from the harness installation or from ${root}, ` +
			`so the AST pass ran no scan; ${unmeasured} was neither found nor cleared. ` +
			"Reinstall without `--omit=optional` to restore it.",
	);
	return null;
}

/** Test-only: forget every cached `typescript`, so the next call resolves again. */
export function resetCheckTypescriptCache(): void {
	harnessTs = null;
	projectTs.clear();
}
