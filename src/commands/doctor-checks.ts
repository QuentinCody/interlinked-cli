// interlinked-tdd: exempt
// ===========================================
// interlinked doctor — local/system check builders
// ===========================================
// Pure CheckResult builders extracted from `doctor.ts` to keep that module
// under the per-file line cap. Each function maps inputs (or a small amount
// of local I/O) to one or more `CheckResult` rows; `doctorCommand` in
// `doctor.ts` orchestrates them. Leaf cluster — nothing here imports from
// `doctor.ts`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	DEFAULT_HARNESS_MODE,
	type HarnessMode,
	migrateLegacyMode,
} from "../harness/rules/modes.js";
import type { CollectionLiveness } from "../lib/collection/liveness.js";
import {
	getConfigDir,
	getLocalConfigPath,
	getSharedConfigPath,
} from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { readGuardDisable } from "../lib/guard-state.js";
import { HOOK_SCRIPT_VERSION, writeHookScript } from "../lib/hooks.js";
import { isJsonObject } from "../lib/json-types.js";
import { functionTokenCapConfigIssue } from "../harness/metric-caps.js";
import { clientHookTargets } from "../lib/settings.js";
import {
	defaultSettingsPaths,
	stripMalformedRules,
	validateSettingsFile,
} from "../lib/settings-validator.js";
import { runSystemChecks } from "./doctor-system.js";
import { harnessServerRow } from "./harness-liveness.js";
import { isHarnessRunning } from "./harness.js";
import type { CheckResult, CheckStatus } from "./doctor-check-types.js";

export type { CheckResult, CheckStatus } from "./doctor-check-types.js";
export { authTokenCheck, legacyConfigCheck } from "./doctor-checks-auth.js";

/**
 * Pull the `mode` field out of a parsed config.json value, or undefined when
 * the value isn't an object or `mode` isn't a string (including a
 * non-object top-level shape like an array or `null`, which the previous
 * unchecked cast let through as "no throw, mode stays undefined" only by
 * accident — a `null` config.json used to throw on `.mode` and rely on the
 * outer catch; this makes "no usable mode" an explicit return instead).
 */
function parseConfiguredMode(value: unknown): string | undefined {
	if (!isJsonObject(value)) return undefined;
	return typeof value.mode === "string" ? value.mode : undefined;
}

/**
 * Build the full version sentinel the hook script SHOULD carry, given the
 * configured mode. Mirror of `writeHookScript`'s `${version}+mode-${name}`
 * shape in `src/lib/hooks.ts`. Used to detect drift when the user changes
 * `mode` outside the `interlinked harness mode` path (e.g. by editing
 * `.interlinked/config.json` directly) — without the mode suffix in the
 * compare, doctor would read `0.1.0+mode-budget` as `0.1.0` and skip the
 * regenerate even though the baked timeout is for the wrong mode.
 */
export function expectedHookVersion(cwd: string): string {
	const sharedConfigPath = getSharedConfigPath(cwd);
	let modeName: HarnessMode = DEFAULT_HARNESS_MODE;
	if (existsSync(sharedConfigPath)) {
		try {
			const raw = parseConfiguredMode(JSON.parse(readFileSync(sharedConfigPath, "utf-8")));
			modeName = migrateLegacyMode(raw, undefined);
		} catch (err) {
			// Malformed config.json — fall back to the default mode and let
			// the broader doctor flow surface a separate "config invalid"
			// finding. Better than crashing the version-check entirely.
			void err;
		}
	}
	return `${HOOK_SCRIPT_VERSION}+mode-${modeName}`;
}

export function statusIcon(status: CheckStatus): string {
	switch (status) {
		case "pass":
			return c.green("[pass]");
		case "fail":
			return c.red("[FAIL]");
		case "warn":
			return c.yellow("[warn]");
	}
}

/** Build the data-collection check row from a liveness reading. Kept out of
 *  `doctorCommand` so it adds no branches to that (already large) function. */
export function collectionLivenessCheck(live: CollectionLiveness): {
	status: CheckStatus;
	message: string;
} {
	const status: CheckStatus = live.status === "live" || live.status === "idle" ? "pass" : "warn";
	switch (live.status) {
		case "live":
			return { status, message: `collection.jsonl flowing -- ${live.reason}` };
		case "idle":
			return { status, message: `collection.jsonl -- ${live.reason}` };
		case "stale":
			return {
				status,
				message: `collection.jsonl STALE -- ${live.reason}. Check 'interlinked harness status' + hook wiring ('interlinked enable').`,
			};
		case "missing":
			return {
				status,
				message:
					"No collection.jsonl yet -- start the daemon and run 'interlinked enable' to begin recording.",
			};
		case "empty":
			return { status, message: "collection.jsonl is empty -- no tool events recorded yet." };
		default:
			return { status, message: `collection.jsonl unreadable -- ${live.reason}` };
	}
}

/** System checks (CPU / memory / orphan daemons), normalized to CheckResult.
 *  `orphanCount` comes from the caller's protection-aware sweep so doctor and
 *  `harness status` cannot disagree about what an orphan is. */
export function systemChecks(orphanCount: number | null): CheckResult[] {
	return runSystemChecks(orphanCount).map((r) => ({
		name: r.name,
		status: r.status,
		message: r.message,
	}));
}

/** Config-directory / shared-config / local-config / agent-identity / hook-presence
 *  checks — the cluster of local existence checks that gate the rest of doctor. */
export function localFileChecks(
	cwd: string,
	resolvedConfig: { agent_name?: string | undefined },
): CheckResult[] {
	const out: CheckResult[] = [];

	// 1. Config directory exists
	if (existsSync(getConfigDir(cwd))) {
		out.push({ name: "Config directory", status: "pass", message: ".interlinked/ exists" });
	} else {
		out.push({
			name: "Config directory",
			status: "fail",
			message: ".interlinked/ not found -- run 'interlinked enable'",
			fixable: false,
		});
	}

	// 2. Shared config exists
	if (existsSync(getSharedConfigPath(cwd))) {
		out.push({ name: "Shared config", status: "pass", message: "config.json exists" });
	} else {
		out.push({
			name: "Shared config",
			status: "fail",
			message: "config.json not found -- run 'interlinked enable'",
		});
	}

	// 3. Local config exists (+ agent identity nudge when present but unnamed)
	if (existsSync(getLocalConfigPath(cwd))) {
		out.push({ name: "Local config", status: "pass", message: "config.local.json exists" });
		if (!resolvedConfig.agent_name) {
			out.push({
				name: "Agent identity",
				status: "warn",
				message:
					"agent_name is not set -- project-level capture uses session-scoped IDs. Set a stable identity with 'interlinked attach --agent <name>'",
			});
		}
	} else {
		out.push({
			name: "Local config",
			status: "warn",
			message: "config.local.json not found -- run 'interlinked login' or 'interlinked register'",
		});
	}

	// 4. Hook script exists (current path or legacy .claude path)
	const hookScriptPath = join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
	const legacyHookPath = join(cwd, ".claude", "hooks", "interlinked-activity.mjs");
	if (existsSync(hookScriptPath) || existsSync(legacyHookPath)) {
		out.push({ name: "Hook script", status: "pass", message: "interlinked-activity.mjs present" });
	} else {
		out.push({
			name: "Hook script",
			status: "warn",
			message: "Hook script not found -- run 'interlinked enable' to install",
		});
	}

	return out;
}

export function metricCapsConfigCheck(cwd: string): CheckResult {
	const issue = functionTokenCapConfigIssue(cwd);
	return issue === null
		? { name: "Function-token cap", status: "pass", message: "max_function_tokens is valid (default 500 when absent)" }
		: { name: "Function-token cap", status: "warn", message: issue };
}

/** Build the single Hook-version CheckResult for a stamp-bearing or stamp-less
 *  hook (no I/O side effects). `--fix` regeneration is applied by the caller. */
function hookVersionResult(installedVersion: string | undefined, expectedVersion: string): CheckResult {
	if (!installedVersion) {
		return {
			name: "Hook version",
			status: "warn",
			message: `No version stamp found (expected ${expectedVersion}) -- run 'interlinked enable' to update`,
			fixable: true,
			fixAction: "regenerate",
		};
	}
	if (installedVersion !== expectedVersion) {
		return {
			name: "Hook version",
			status: "warn",
			message: `Installed v${installedVersion}, expected v${expectedVersion} -- run 'interlinked enable' to update`,
			fixable: true,
			fixAction: "regenerate",
		};
	}
	return { name: "Hook version", status: "pass", message: `v${installedVersion} (current)` };
}

/** Hook-version drift check (4b). Only meaningful when the `.interlinked` hook
 *  exists; returns [] otherwise. Applies the `--fix` regenerate in-place. */
export function hookVersionChecks(cwd: string, fix: boolean): CheckResult[] {
	const hookScriptPath = join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
	if (!existsSync(hookScriptPath)) return [];
	try {
		const hookContent = readFileSync(hookScriptPath, "utf-8");
		// Capture the FULL version sentinel including any `+mode-<name>` suffix
		// baked in by `writeHookScript` (see `src/lib/hooks.ts`). The previous
		// `[\d.]+` form stopped at the first `+`, reading `0.1.0+mode-budget` as
		// just `0.1.0` so a `mode budget → ci` switch outside `harness mode`
		// (manual config edit) appeared "current" and `--fix` skipped regenerate.
		const versionMatch = hookContent.match(/interlinked-hook-version:\s*(\S+)/);
		const installedVersion = versionMatch?.[1];
		const expectedVersion = expectedHookVersion(cwd);
		const result = hookVersionResult(installedVersion, expectedVersion);
		if (result.status === "pass" || !fix) return [result];
		// --fix path: regenerate and report the transition.
		writeHookScript(cwd);
		const fixedMessage = installedVersion
			? `Updated hook script from v${installedVersion} to v${expectedVersion}`
			: `Regenerated hook script (v${expectedVersion})`;
		return [{ name: "Hook version", status: "pass", message: fixedMessage }];
	} catch {
		return [
			{
				name: "Hook version",
				status: "warn",
				message: "Could not read hook script for version check",
			},
		];
	}
}

/** Build the per-client hooks CheckResult from a settings file's content.
 *  Moved to doctor-install-drift.ts (this file is over its line cap): PARSES
 *  the document and asks the shared ownership walk — the shell-command
 *  recognizer never sees serialized JSON (review 2026-08-30 final pass). */
import { clientHookResult } from "./doctor-install-drift.js";

/** Codex runs hooks only when `.codex/config.toml` carries `[features] hooks =
 *  true` (legacy key: `codex_hooks`). Extracted to doctor-checks-codex.ts
 *  (this file is over the size cap) — it now also FAILS on duplicate
 *  [features] tables, which are invalid TOML Codex rejects wholesale. */
import {
	codexFeatureFlagResult,
	codexRuntimeReceiptResult,
} from "./doctor-checks-codex.js";

/** Client hooks installed (5) — every client in the settings registry, so a
 *  newly supported runner is covered the moment it is registered rather than
 *  when someone remembers to add it here. Clients whose config dir is absent
 *  are skipped entirely. Paths come from `clientHookTargets`; doctor must not
 *  restate them (the hardcoded `.codex/config.toml` entry this replaces made
 *  doctor warn about every correct Codex install). */
export function clientHookChecks(cwd: string): CheckResult[] {
	const out: CheckResult[] = [];
	for (const client of clientHookTargets(cwd)) {
		if (!existsSync(client.configDir)) continue; // Skip clients that aren't present

		if (!existsSync(client.settingsPath)) {
			out.push({
				name: `${client.label} hooks`,
				status: "warn",
				message: `${basename(client.settingsPath)} not found`,
			});
			continue;
		}
		try {
			out.push(clientHookResult(client.label, readFileSync(client.settingsPath, "utf-8")));
		} catch {
			out.push({
				name: `${client.label} hooks`,
				status: "warn",
				message: "Could not read settings file",
			});
		}
		if (client.name === "codex") {
			const flag = codexFeatureFlagResult(client.configDir);
			if (flag) out.push(flag);
			out.push(codexRuntimeReceiptResult(cwd));
		}
	}
	return out;
}

/** Permission-rule hygiene across Claude Code settings files (5b). Claude
 *  Code's "Always allow" extractor occasionally writes rules with mismatched
 *  parentheses; we scan all known settings files and (with --fix) strip them. */
export function permissionRuleChecks(cwd: string, fix: boolean): CheckResult[] {
	const out: CheckResult[] = [];
	for (const settingsPath of defaultSettingsPaths(cwd)) {
		const v = validateSettingsFile(settingsPath);
		if (!v.exists || v.parseError) continue;
		if (v.malformed.length === 0) continue;
		const display = settingsPath.replace(`${cwd}/`, "").replace(process.env.HOME ?? "~", "~");
		const checkName = `Permission rules (${display})`;
		if (fix) {
			const stripped = stripMalformedRules(settingsPath);
			out.push({
				name: checkName,
				status: "pass",
				message: `Stripped ${stripped} malformed rule(s) from ${display}`,
			});
			continue;
		}
		const sample = v.malformed[0]?.rule.slice(0, 60) ?? "";
		out.push({
			name: checkName,
			status: "warn",
			message: `${v.malformed.length} malformed rule(s) -- e.g. ${JSON.stringify(sample)}${
				sample.length === 60 ? "..." : ""
			}. Run 'interlinked doctor --fix' to strip.`,
			fixable: true,
			fixAction: "strip-permission-rules",
		});
	}
	return out;
}

/** Build the Session-files CheckResult from a directory's file listing (8). */
function sessionFilesResult(sessionsDir: string, cwd: string, files: string[]): CheckResult {
	const staleThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24h
	const staleFiles = files.filter((f) => {
		try {
			return statSync(join(sessionsDir, f)).mtimeMs < staleThreshold;
		} catch {
			return false;
		}
	});
	const display = sessionsDir.replace(`${cwd}/`, "");
	if (staleFiles.length > 0) {
		return {
			name: "Session files",
			status: "warn",
			message: `${staleFiles.length} stale session file(s) in ${display} -- run 'interlinked clean'`,
			fixable: true,
			fixAction: "clean",
		};
	}
	return {
		name: "Session files",
		status: "pass",
		message: files.length > 0 ? `${files.length} active session file(s)` : "No session files",
	};
}

/** Stale session-file scan (8). Returns [] when no sessions dir exists. */
export function sessionFileChecks(cwd: string): CheckResult[] {
	const sessionsDir = existsSync(join(cwd, ".interlinked", "sessions"))
		? join(cwd, ".interlinked", "sessions")
		: join(cwd, ".interlinked", "hooks", "agent-sessions");
	if (!existsSync(sessionsDir)) return [];
	try {
		return [sessionFilesResult(sessionsDir, cwd, readdirSync(sessionsDir))];
	} catch {
		return [
			{
				name: "Session files",
				status: "warn",
				message: `Could not read ${sessionsDir.replace(`${cwd}/`, "")}`,
			},
		];
	}
}

/** Node runtime + harness server + guard rules (9–11). */
/** A loud row when the project is intentionally stood down (`interlinked
 *  disable`). Returns [] when the guard is active, so the caller spreads it
 *  without adding a branch (keeps `harnessChecks` under the complexity ratchet). */
function guardStandDownChecks(configDir: string): CheckResult[] {
	const standDown = readGuardDisable(configDir);
	if (!standDown) return [];
	const who = standDown.by ? ` by ${standDown.by}` : "";
	const why = standDown.reason ? ` — "${standDown.reason}"` : "";
	const scope = standDown.source === "team" ? "committed/team" : "personal";
	return [
		{
			name: "Guard stand-down",
			status: "warn",
			message: `Harness STOOD DOWN here (${scope}${who})${why}. Re-arm with 'interlinked enable'`,
		},
	];
}

/** `socketAnswered` is the caller's ROUND-TRIP result (`probeHarnessSocket`).
 *  Omitting it keeps the pre-probe wording — a caller that cannot await must
 *  not have a verdict invented for it. */
export function harnessChecks(
	cwd: string,
	configDir: string,
	socketAnswered?: boolean,
): CheckResult[] {
	const out: CheckResult[] = [];
	out.push(...guardStandDownChecks(configDir));

	// 9. Node.js runtime
	out.push({
		name: "Node.js runtime",
		status: "pass",
		message: `${process.version} (${process.execPath})`,
	});

	// 10. Harness server — a live pid is not evidence that anything is
	// listening; `socketAnswered` is what separates running from ZOMBIE.
	const harnessStatus = isHarnessRunning(cwd);
	out.push({
		name: "Harness server",
		...harnessServerRow({
			processRunning: harnessStatus.running,
			pid: harnessStatus.pid,
			socketExists: existsSync(join(configDir, "harness.sock")),
			socketAnswered,
		}),
	});

	// 11. Guard rules
	if (existsSync(join(configDir, "guard-rules.json"))) {
		out.push({
			name: "Guard rules",
			status: "pass",
			message: "guard-rules.json present (team-shared rules)",
		});
	} else {
		out.push({
			name: "Guard rules",
			status: "warn",
			message: "guard-rules.json not found -- harness uses built-in rules only",
		});
	}

	return out;
}
