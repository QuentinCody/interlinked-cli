// ===========================================
// Phase C — interlinked harness mode <name>
// ===========================================
// Switches the operational tier (budget / quality / ci). Persists to
// `.interlinked/config.json`'s `mode` field and regenerates the hook .mjs
// so the new HARNESS_POST_TIMEOUT_MS literal is baked in.
//
// Distinct from `interlinked mode <name>` (the check-policy command in
// commands/mode.ts) — that one governs per-check action overrides
// (balanced/strict/lenient/custom), which is orthogonal to the operational
// tier this command controls.
//
// Usage:
//   interlinked harness mode                 # show current
//   interlinked harness mode budget          # switch to budget (30 s)
//   interlinked harness mode quality         # switch to quality (50 s)
//   interlinked harness mode ci              # switch to ci (60 s)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestPath, readManifest } from "../harness/installer.js";
import {
	getModePreset,
	HARNESS_MODE_NAMES,
	type HarnessMode,
	isKnownMode,
	migrateLegacyMode,
} from "../harness/rules/modes.js";
import type { RunnerId } from "../harness/unified-event.js";
import {
	getSharedConfigPath,
	readSharedConfig,
	writeSharedConfig,
} from "../lib/config.js";
import { writeHookScript } from "../lib/hooks.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";

export interface HarnessModeOptions {
	json?: boolean;
}

/** Detect the active runner from `.interlinked/installer-manifest.json` if
 *  one is present. Returns the first runner id we find — usually a project
 *  has a single primary runner, and the migration policy only differentiates
 *  Copilot from non-Copilot anyway. */
function detectActiveRunner(cwd: string): RunnerId | undefined {
	const mfPath = manifestPath(cwd);
	if (!existsSync(mfPath)) return undefined;
	const entries = readManifest(mfPath);
	return entries.length > 0 ? nonNull(entries[0]).runner : undefined;
}

/** Read the configured mode from disk, applying legacy migration. Falls back
 *  to the documented default if no config or no mode key is present. */
function readCurrentMode(cwd: string): HarnessMode {
	const shared = readSharedConfig(cwd);
	const raw = typeof shared?.mode === "string" ? shared.mode : undefined;
	const runner = detectActiveRunner(cwd);
	return migrateLegacyMode(raw, runner);
}

/** Map a runner id to a human-friendly tier-alignment hint for the
 *  confirmation message. Used after a successful mode switch so the user
 *  immediately sees whether the chosen mode fits their primary runner. */
function tierHintForMode(mode: HarnessMode): string {
	const preset = getModePreset(mode);
	const seconds = (preset.post_timeout_ms / 1_000).toFixed(0);
	switch (mode) {
		case "budget":
			return `${mode} mode (${seconds} s) — recommended for Copilot CLI`;
		case "quality":
			return `${mode} mode (${seconds} s) — recommended for Claude Code, Cursor, Gemini`;
		case "ci":
			return `${mode} mode (${seconds} s) — recommended for Codex and CI runners`;
	}
}

/** Surface a runner-mismatch warning when the user picks an operational tier
 *  that's tighter than what their primary runner supports. Quiet otherwise.
 *  Returns the warning string or null. */
function runnerMismatchWarning(mode: HarnessMode, runner: RunnerId | undefined): string | null {
	if (!runner) return null;
	if (runner === "copilot-cli" && mode !== "budget") {
		return `[interlinked] Note: Copilot CLI's hook timeout floor is 30 s. ${mode} mode (${
			getModePreset(mode).post_timeout_ms / 1_000
		} s) may exceed it on slower edits — consider 'interlinked harness mode budget'.`;
	}
	return null;
}

export async function harnessModeCommand(
	name: string | undefined,
	options: HarnessModeOptions,
): Promise<void> {
	const cwd = process.cwd();

	// Show current mode
	if (!name) {
		const current = readCurrentMode(cwd);
		const preset = getModePreset(current);
		if (options.json) {
			process.stdout.write(
				`${JSON.stringify(
					{
						mode: current,
						post_timeout_ms: preset.post_timeout_ms,
						description: preset.description,
						available_modes: HARNESS_MODE_NAMES.map((n) => {
							const p = getModePreset(n);
							return {
								name: n,
								post_timeout_ms: p.post_timeout_ms,
								description: p.description,
							};
						}),
					},
					null,
					2,
				)}\n`,
			);
			return;
		}
		process.stdout.write(`Current harness mode: ${current}\n`);
		process.stdout.write(`  ${preset.description}\n`);
		process.stdout.write(`\nAvailable modes:\n`);
		for (const m of HARNESS_MODE_NAMES) {
			const p = getModePreset(m);
			process.stdout.write(`  ${m.padEnd(8)} ${p.post_timeout_ms / 1_000} s — ${p.description}\n`);
		}
		process.stdout.write(`\nSwitch: interlinked harness mode <name>\n`);
		return;
	}

	// Switch mode — validate first
	if (!isKnownMode(name)) {
		const message = `unknown harness mode: ${name}. Known: ${HARNESS_MODE_NAMES.join(", ")}`;
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, reason: message })}\n`);
		} else {
			process.stderr.write(`[interlinked] ${message}\n`);
		}
		process.exitCode = 1;
		return;
	}

	// Persist via writeSharedConfig — preserves any other fields already in
	// the file (server_url, skip_paths, pii_patterns, ...). If no shared
	// config exists yet, we initialise one with the minimum required shape.
	const existing = readSharedConfigSafe(cwd);
	const updated = {
		...existing,
		version: 1,
		server_url: existing.server_url || "http://localhost:8787",
		mode: name,
	};
	writeSharedConfig(updated, cwd);

	// Regenerate the hook .mjs so HARNESS_POST_TIMEOUT_MS picks up the new
	// preset's timeout literal. Skipped silently if the hook directory
	// hasn't been initialised yet (no `interlinked enable` run) — the next
	// enable / install-hooks invocation will pick up the mode at write time.
	if (existsSync(join(cwd, ".interlinked"))) {
		writeHookScript(cwd);
	}

	const runner = detectActiveRunner(cwd);
	const mismatch = runnerMismatchWarning(name, runner);
	const preset = getModePreset(name);

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: true,
					mode: name,
					post_timeout_ms: preset.post_timeout_ms,
					description: preset.description,
					runner_hint: tierHintForMode(name),
					...(mismatch ? { warning: mismatch } : {}),
					path: getSharedConfigPath(cwd),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	process.stdout.write(`[interlinked] ${tierHintForMode(name)}\n`);
	if (mismatch) {
		process.stderr.write(`${mismatch}\n`);
	}
	process.stdout.write(
		`[interlinked] Restart the harness to pick up the new timeout: interlinked harness restart\n`,
	);
}

const DEFAULT_SHARED_CONFIG = { version: 1, server_url: "http://localhost:8787" };

/** Read shared config with a clean object fallback so the spread above
 *  always has a defined source. Distinct from readSharedConfig because that
 *  helper returns null when no file exists, which would make the spread
 *  expand to nothing usable. */
function readSharedConfigSafe(cwd: string): JsonObject & { version: number; server_url: string } {
	const sharedPath = getSharedConfigPath(cwd);
	if (!existsSync(sharedPath)) {
		return DEFAULT_SHARED_CONFIG;
	}
	try {
		const raw = JSON.parse(readFileSync(sharedPath, "utf-8"));
		// A malformed config.json whose top level is an array/string/number
		// (not a JSON object) would otherwise spread numeric-string keys into
		// the merged result below, and that garbage gets persisted back to the
		// COMMITTED config.json on the next `writeSharedConfig` call. Reject
		// it here and fall back to defaults instead.
		if (!isJsonObject(raw)) {
			return DEFAULT_SHARED_CONFIG;
		}
		// Preserve unknown fields for round-trip writes while promising only the
		// version and server URL checked here. Readers validate their own settings.
		const parsed = raw;
		return {
			...parsed,
			version: 1,
			server_url: typeof parsed.server_url === "string" && parsed.server_url.length > 0
				? parsed.server_url : DEFAULT_SHARED_CONFIG.server_url,
		};
	} catch {
		return DEFAULT_SHARED_CONFIG;
	}
}
