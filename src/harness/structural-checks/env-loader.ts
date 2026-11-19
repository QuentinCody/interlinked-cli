// ===========================================
// .env example loader (used by undefined-env-vars check)
// ===========================================
// Helpers for reading `.env.example` / `.env.sample` / `.env.template`
// files when the undefined_env_vars check wants to compare a file's
// `process.env.FOO` references against documented variables.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Public API — consumed by structural-checks/env-vars.ts.
 *
 * Look for `.env.example`/`.env.sample`/`.env.template` in `dir` and parse it
 * into a Set of declared variable names. Returns null when no such file exists
 * so the caller can walk parent directories.
 */
export function readEnvExampleFromDir(dir: string): Set<string> | null {
	for (const name of [".env.example", ".env.sample", ".env.template"]) {
		const envPath = join(dir, name);
		if (!existsSync(envPath)) continue;
		try {
			const envContent = readFileSync(envPath, "utf-8");
			return parseEnvKeys(envContent);
		} catch (_err) {
			void 0; /* intentional: unreadable env file — return empty Set so caller stops walking */
			return new Set();
		}
	}
	return null;
}

/**
 * Public API — consumed by readEnvExampleFromDir.
 *
 * Example catalogs also use commented assignments to document optional keys.
 */
export function parseEnvKeys(envContent: string): Set<string> {
	const out = new Set<string>();
	for (const line of envContent.split("\n")) {
		const key = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
		if (key) out.add(key);
	}
	return out;
}
