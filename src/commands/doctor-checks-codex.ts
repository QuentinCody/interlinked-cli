// ===========================================
// Doctor — OpenAI Codex CLI feature-flag row (extracted from doctor-checks.ts,
// which sits over the file-size cap)
// ===========================================
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	findFeaturesHooksAssignmentCounts,
	findFeaturesTableHeaderLines,
	readCodexHooksFlag,
} from "../lib/codex-feature-flag.js";
import {
	hashHookDefinition,
	HOOK_RUNTIME_RECEIPT_FILE,
	readHookRuntimeReceipt,
} from "../lib/hook-runtime-receipt.js";
import type { CheckResult } from "./doctor-checks.js";

/** Codex runs hooks only when `.codex/config.toml` carries `[features] hooks =
 *  true` (legacy key: `codex_hooks`). A correct hooks.json with the flag
 *  missing is an install that silently never fires, so doctor names THAT as
 *  the defect instead of claiming the hooks are absent. */
export function codexFeatureFlagResult(configDir: string): CheckResult {
	const tomlPath = join(configDir, "config.toml");
	if (!existsSync(tomlPath)) {
		return {
			name: "OpenAI Codex CLI feature flag",
			status: "warn",
			message: "config.toml not found -- hooks stay inert until [features] hooks = true; run 'interlinked enable'",
		};
	}
	try {
		const text = readFileSync(tomlPath, "utf-8");
		// Duplicate [features] headers make the file invalid TOML: Codex rejects
		// it WHOLE and no hook fires, while the last-wins assignment scan would
		// still read "enabled" — a green row for an inert install (Grok
		// 2026-08-28 issue 8). This is the case the writer exports the header
		// finder for.
		if (findFeaturesTableHeaderLines(text).length > 1) {
			return {
				name: "OpenAI Codex CLI feature flag",
				status: "fail",
				message:
					"config.toml has DUPLICATE [features] tables -- invalid TOML, Codex rejects the whole file and no hook fires; merge the duplicate tables into one, then re-run 'interlinked enable'",
			};
		}
		// Duplicate KEYS inside one table are also invalid TOML (review
		// 2026-08-28): `hooks = true` twice makes Codex reject the file while
		// the last-wins scan reads "enabled".
		const counts = findFeaturesHooksAssignmentCounts(text);
		if (counts.hooks > 1 || counts.codex_hooks > 1) {
			return {
				name: "OpenAI Codex CLI feature flag",
				status: "fail",
				message:
					"config.toml assigns the hooks key more than once in [features] -- invalid TOML, Codex rejects the whole file and no hook fires; remove the duplicate assignment, then re-run 'interlinked enable'",
			};
		}
		// One shared, TABLE-AWARE reader (`readCodexHooksFlag`). Doctor's own
		// regex accepted `hooks = true` under ANY table, so a config that set it
		// under `[other]` and `false` under `[features]` reported a green row for
		// an install whose hooks never fire.
		const state = readCodexHooksFlag(text);
		if (state === "enabled") {
			return { name: "OpenAI Codex CLI feature flag", status: "pass", message: "[features] hooks = true" };
		}
		return {
			name: "OpenAI Codex CLI feature flag",
			status: "warn",
			message:
				state === "disabled"
					? "[features] hooks = false -- hooks are installed but never fire; set it to true"
					: "[features] hooks = true missing -- hooks are installed but never fire; run 'interlinked enable'",
		};
	} catch {
		return { name: "OpenAI Codex CLI feature flag", status: "warn", message: "Could not read config.toml" };
	}
}

/** Codex requires users to review changed project hook definitions. The CLI
 * does not expose Codex's private trust store, so doctor verifies the stronger
 * observable fact: the current hooks.json hash has actually executed. */
export function codexRuntimeReceiptResult(projectRoot: string): CheckResult {
	const receiptPath = join(projectRoot, ".interlinked", HOOK_RUNTIME_RECEIPT_FILE);
	const hooksPath = join(projectRoot, ".codex", "hooks.json");
	const observation = readHookRuntimeReceipt(receiptPath)?.providers.codex;
	if (!observation) return missingRuntimeReceipt();
	const currentHash = hashHookDefinition(hooksPath);
	if (!currentHash || observation.definition_sha256 !== currentHash) {
		return {
			name: "OpenAI Codex CLI hook execution",
			status: "warn",
			message:
				"Current hooks.json has not executed -- open /hooks in Codex, review the definition, then run any hooked action",
		};
	}
	return {
		name: "OpenAI Codex CLI hook execution",
		status: "pass",
		message: `Current definition executed (${observation.native_event}, ${observation.observed_at})`,
	};
}

function missingRuntimeReceipt(): CheckResult {
	return {
		name: "OpenAI Codex CLI hook execution",
		status: "warn",
		message:
			"No verified execution for current hooks.json -- open /hooks in Codex, review the definition, then run any hooked action",
	};
}
