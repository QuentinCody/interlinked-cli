// ===========================================
// doctor — drift-aware installed-hook verification
// ===========================================
// Review 2026-08-30: doctor's per-client hook check only asked "does any
// Interlinked-looking command exist in the settings file", so a stale binary
// path, a deregistered event, or a missing event all passed. This check runs
// the SAME semantic verifier the refresh command uses (installed-hooks-
// verify.ts) over every installer-manifest entry, so "healthy" means one
// thing across doctor and refresh. Posture-enum findings live in
// doctor-posture.ts (split so the installer bundle and the mode/config
// bundle commit independently).

import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { documentContainsInterlinkedHook } from "../lib/hook-ownership.js";
import { verifyInstalledRunner } from "../harness/installed-hooks-verify.js";
import { manifestPath, readManifestState } from "../harness/installer.js";
import { isManagedProviderFile } from "../harness/managed-provider-file.js";
import type { CheckResult } from "./doctor-checks.js";

const REPAIR = "run 'interlinked install-hooks --refresh --preserve-mode'";
const CORRUPT_MANIFEST_REPAIR =
	"restore a trusted installer-manifest.json backup or repair it to the valid schema; manifest-scoped refresh cannot reconstruct missing ownership records";
const HOOK_PROBE_RUNNER = "__interlinked_bootstrap_probe__";
const HOOK_PROBE_STDERR = `[interlinked] unknown runner id: ${HOOK_PROBE_RUNNER}\n`;

function hookRuntimeSelfCheckProblem(path: string): string | null {
	const result = spawnSync(
		process.execPath,
		[path, `--runner=${HOOK_PROBE_RUNNER}`, "--event=PreToolUse"],
		{ input: "{}\n", encoding: "utf8", timeout: 5_000 },
	);
	if (
		result.error === undefined &&
		result.status === 0 &&
		result.stdout === "" &&
		result.stderr === HOOK_PROBE_STDERR
	) {
		return null;
	}
	return `hook binary self-check failed: ${path}`;
}

function hookBinaryProblem(path: string): string | null {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return `hook binary is not a regular file: ${path}`;
		if (stat.size === 0) return `hook binary is empty: ${path}`;
		return hookRuntimeSelfCheckProblem(path);
	} catch {
		return `hook binary missing: ${path}`;
	}
}

/** One row per manifest-tracked runner: pass when the semantic verifier is
 *  clean, warn (with the first problems and the SAFE repair command)
 *  otherwise. A corrupt manifest is its own finding; a missing manifest is a
 *  never-installed repo and yields no rows. */
export function installedHookDriftChecks(cwd: string, binaryAbs: string): CheckResult[] {
	const state = readManifestState(manifestPath(cwd));
	if (state.kind === "missing") return [];
	if (state.kind === "corrupt") {
		return [
			{
				name: "Installer manifest",
				status: "fail",
				message: `installer-manifest.json is corrupt (${state.reason}) — ${CORRUPT_MANIFEST_REPAIR}`,
			},
		];
	}
	return state.entries.map((entry): CheckResult => {
		const installedBinary = entry.binary_path;
		const runtimeProblem = hookBinaryProblem(installedBinary);
		if (runtimeProblem !== null) {
			return {
				name: `${entry.runner} install drift`,
				status: "fail",
				message: `${runtimeProblem} — ${REPAIR}`,
			};
		}
		const v = verifyInstalledRunner(cwd, entry, binaryAbs);
		if (v.verified) {
			return { name: `${entry.runner} install drift`, status: "pass", message: "hooks match the adapter and current binary" };
		}
		return {
			name: `${entry.runner} install drift`,
			status: "warn",
			message: `${v.problems.slice(0, 3).join("; ")} — ${REPAIR}`,
		};
	});
}

/** Per-client "hooks installed?" row — moved here from doctor-checks.ts
 *  (that file is over its line cap). PARSES the settings document and asks
 *  the SAME ownership walk every installer and cleanup path uses (review
 *  2026-08-30 final pass: the shell-command recognizer takes one command
 *  string, never serialized JSON). */
export function clientHookResult(clientName: string, content: string): CheckResult {
	if (isManagedProviderFile(content)) {
		return { name: `${clientName} hooks`, status: "pass", message: "Provider bridge installed" };
	}
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(content);
	} catch {
		parsed = null; // unparseable settings → no recognizable hooks
	}
	if (documentContainsInterlinkedHook(parsed)) {
		return { name: `${clientName} hooks`, status: "pass", message: "Hooks installed" };
	}
	return {
		name: `${clientName} hooks`,
		status: "warn",
		message: "Settings file exists but no Interlinked CLI hooks -- run 'interlinked enable'",
	};
}
