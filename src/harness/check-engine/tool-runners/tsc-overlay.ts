// ===========================================
// Tool Runner — TypeScript Diff-Overlay (dispatcher)
// ===========================================
// Detects type errors introduced by a proposed edit BEFORE it lands, by
// running TypeScript's incremental LanguageService against an in-memory
// overlay of the target file. This module is the PUBLIC entry point;
// the LanguageService-construction logic itself lives in
// tsc-overlay-service.ts (shared with the sidecar process entry).
//
// Modes (config: `tsc_overlay.mode`, default "sidecar"):
//   - "sidecar"    (default) — spawn a disposable child process per check.
//     The whole-project LanguageService heap (~1-2GB on this repo) lives in
//     that child, not the daemon; every sidecar failure mode degrades to
//     no findings + one stderr warning (tsc-overlay-sidecar-client.ts).
//   - "in-process" — run the LanguageService directly in this process (the
//     pre-2026-08 behavior). Faster per-call (no spawn), but the daemon
//     pays the retained heap — this is the RSS-pinning problem the sidecar
//     exists to fix. Kept as an explicit opt-out and for the existing
//     LS-behavior test suite (tsc-overlay.test.ts).
//   - "off" — never run the overlay check.
//
// Deliberate departure from a fully async sidecar transport: see the module
// doc in tsc-overlay-sidecar-client.ts for why this stays synchronous.

import { loadRules } from "../../rules-loader.js";
import { tryAcquireProjectCompilerLease } from "../../project-compiler-gate.js";
import type { CheckResult } from "../types.js";
import {
	runOverlayViaSidecarTyped,
	type SidecarOverlayOutcome,
} from "./tsc-overlay-sidecar-client.js";
import {
	clearOverlayServiceCache,
	OVERLAY_EXT,
	type RunTscOverlayInput,
	runOverlayCheckInProcessTyped,
} from "./tsc-overlay-service.js";

export type { RunTscOverlayInput };

type TscOverlayMode = "sidecar" | "in-process" | "off";

const DEFAULT_MODE: TscOverlayMode = "sidecar";

/** Cached per project root so every overlay check doesn't re-read
 *  guard-rules.json off disk — refreshed by clearTscOverlayCache. */
const _modeCache = new Map<string, TscOverlayMode>();

/** Test-only override — bypasses loadRules entirely so unit tests (which
 *  run against tmpdir "projects" with no real .interlinked/ config) can pin
 *  a mode without writing config files. `null` clears the override. */
let _modeOverrideForTest: TscOverlayMode | null = null;

export function _setTscOverlayModeOverrideForTest(mode: TscOverlayMode | null): void {
	_modeOverrideForTest = mode;
	_modeCache.clear();
}

function getTscOverlayMode(projectRoot: string): TscOverlayMode {
	if (_modeOverrideForTest) return _modeOverrideForTest;
	const cached = _modeCache.get(projectRoot);
	if (cached) return cached;
	let mode: TscOverlayMode = DEFAULT_MODE;
	try {
		mode = loadRules(projectRoot).tsc_overlay?.mode ?? DEFAULT_MODE;
	} catch {
		// intentional: a tmpdir/fixture project root with no readable config
		// tree falls back to the default rather than throwing out of a
		// PreToolUse check.
		mode = DEFAULT_MODE;
	}
	_modeCache.set(projectRoot, mode);
	return mode;
}

/**
 * Typed outcome of one overlay run. Three states, deliberately distinct
 * (review pass 18 — "disabled" and "checked clean" must not share a shape):
 *   "ok"          — the checker RAN; findings (possibly empty = checked clean)
 *   "skipped"     — the check deliberately did not apply (non-TS extension,
 *                   operator mode "off"); nothing was verified, and nothing
 *                   was expected to be — transactions may proceed but must
 *                   never describe the result as tsc-verified
 *   "unavailable" — the checker SHOULD have run and could not (spawn
 *                   failure, timeout, malformed reply, cooldown) —
 *                   transaction consumers must abort, never read as clean
 */
export type TscOverlayOutcome = SidecarOverlayOutcome | { status: "skipped"; reason: string };

/**
 * Run the overlay check against a proposed file content, dispatching to the
 * configured transport. Returns diagnostics FOR THAT FILE ONLY. Cross-file
 * regressions (an edit to A breaks B) are left to PostToolUse.
 */
export function runTscOverlayTyped(input: RunTscOverlayInput): TscOverlayOutcome {
	if (!OVERLAY_EXT.test(input.filePath)) {
		return { status: "skipped", reason: "not a TypeScript/JavaScript file" };
	}

	const mode = getTscOverlayMode(input.projectRoot);
	if (mode === "off") return { status: "skipped", reason: "tsc overlay disabled by config" };
	if (mode === "in-process") {
		const releaseCompiler = tryAcquireProjectCompilerLease(input.projectRoot);
		if (!releaseCompiler) {
			return {
				status: "unavailable",
				reason: "in-process TypeScript overlay deferred because another compiler owns this project",
			};
		}
		try {
			const run = runOverlayCheckInProcessTyped(input);
			return run.status === "ok"
				? { status: "ok", findings: run.findings }
				: { status: "unavailable", reason: run.reason };
		} finally {
			releaseCompiler();
		}
	}
	return runOverlayViaSidecarTyped(input);
}

/**
 * Legacy findings-only shape — "unavailable" collapses to `[]` (advisory
 * callers keep today's behavior; the sidecar client's stderr warning is the
 * visible signal). Transactional callers must use `runTscOverlayTyped`.
 */
export function runTscOverlay(input: RunTscOverlayInput): CheckResult[] {
	const outcome = runTscOverlayTyped(input);
	return outcome.status === "ok" ? outcome.findings : [];
}

/**
 * Drop the cached LanguageService (in-process mode) and mode resolution
 * (both modes) for a project (or all projects). Call when tsconfig.json
 * changes, files are added/removed, or (daemon path) to shed retained heap
 * under idle/RSS pressure.
 */
export function clearTscOverlayCache(projectRoot?: string): void {
	clearOverlayServiceCache(projectRoot);
	if (projectRoot) {
		_modeCache.delete(projectRoot);
	} else {
		_modeCache.clear();
	}
}
