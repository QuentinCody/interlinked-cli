// ===========================================
// Rules — Guard Rules File I/O
// ===========================================
// Read/write helpers for `.interlinked/guard-rules.json` (team) and
// `.interlinked/guard-rules.local.json` (personal). Used by the
// `interlinked reminder` command to manage file reminders without
// requiring users to hand-edit JSON.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

function guardRulesPath(cwd: string, local: boolean): string {
	return join(cwd, ".interlinked", local ? "guard-rules.local.json" : "guard-rules.json");
}

function readGuardRulesFile(cwd: string, local: boolean): JsonObject | null {
	const path = guardRulesPath(cwd, local);
	if (!existsSync(path)) return null;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isJsonObject(value) ? value : null;
	} catch {
		return null;
	}
}

function writeGuardRulesFile(cwd: string, local: boolean, data: JsonObject): void {
	const path = guardRulesPath(cwd, local);
	const dir = join(cwd, ".interlinked");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(data, null, 4)}\n`);
}

/**
 * Public API — consumed by `src/commands/reminder.ts` and re-exported
 * from `rules-loader.ts`. Reads the personal (gitignored) config file.
 */
export function readLocalGuardRules(cwd?: string): JsonObject | null {
	return readGuardRulesFile(cwd || process.cwd(), true);
}

/**
 * Public API — consumed by `src/commands/reminder.ts` and re-exported
 * from `rules-loader.ts`. Writes the personal (gitignored) config file.
 */
export function writeLocalGuardRules(data: JsonObject, cwd?: string): void {
	writeGuardRulesFile(cwd || process.cwd(), true, data);
}

/**
 * Public API — consumed by `src/commands/reminder.ts` and re-exported
 * from `rules-loader.ts`. Reads the team (committed) config file.
 */
export function readTeamGuardRules(cwd?: string): JsonObject | null {
	return readGuardRulesFile(cwd || process.cwd(), false);
}

/**
 * Public API — consumed by `src/commands/reminder.ts` and re-exported
 * from `rules-loader.ts`. Writes the team (committed) config file.
 */
export function writeTeamGuardRules(data: JsonObject, cwd?: string): void {
	writeGuardRulesFile(cwd || process.cwd(), false, data);
}
