// ============================================================
// Library footgun registry — aggregator + opt-out
// ============================================================
// Aggregates every library-specific footgun module into a single
// list and exposes `runFootgunChecks(content, filePath, disabled)`
// as the consumer-facing entry point. The harness pipeline calls
// this once per PostToolUse Edit/Write event.
//
// Per-library opt-out: callers pass a Set<string> of disabled
// library names (matching `LibraryFootgunCheck.library`). The
// helper `loadDisabledLibraries(repoRoot)` reads the user's
// .interlinked/disabled-libraries.json so the daemon can call
// runFootgunChecks(content, filePath, loadDisabledLibraries(cwd)).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineMatch } from "../checks/shared.js";
import { CHILD_PROCESS_FOOTGUNS } from "./child-process.js";
import { D1_FOOTGUNS } from "./d1.js";
import { NODE_FETCH_FOOTGUNS } from "./node-fetch.js";
import { REDIS_FOOTGUNS } from "./redis.js";
import type { DisabledLibrariesConfig, LibraryFootgunCheck } from "./types.js";
import { WORKERS_KV_FOOTGUNS } from "./workers-kv.js";

/** A footgun finding emitted by the registry. Wraps an InlineMatch
 *  with the check id so the consumer knows which detector fired. */
interface FootgunFinding {
	id: string;
	library: string;
	name: string;
	match: InlineMatch;
	fixInstruction: string;
}

/** All bundled footgun checks across every library module. */
export function getAllFootguns(): LibraryFootgunCheck[] {
	// Concatenate each library's module here. Adding a new library
	// is a one-line append below.
	return [
		...NODE_FETCH_FOOTGUNS,
		...REDIS_FOOTGUNS,
		...D1_FOOTGUNS,
		...WORKERS_KV_FOOTGUNS,
		...CHILD_PROCESS_FOOTGUNS,
	];
}

/** Filter the bundled footguns by the disabled-libraries set. */
export function getEnabledFootguns(disabled: Set<string>): LibraryFootgunCheck[] {
	if (disabled.size === 0) return getAllFootguns();
	return getAllFootguns().filter((f) => !disabled.has(f.library));
}

/** Load `.interlinked/disabled-libraries.json`. Returns an empty
 *  set on missing / malformed / wrong-version. Never throws. */
export function loadDisabledLibraries(repoRoot: string): Set<string> {
	const path = join(repoRoot, ".interlinked", "disabled-libraries.json");
	if (!existsSync(path)) return new Set();
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof raw !== "object" || raw === null) return new Set();
		const c = raw as Partial<DisabledLibrariesConfig>;
		if (c.version !== 1 || !Array.isArray(c.disabled)) return new Set();
		return new Set(c.disabled.filter((x) => typeof x === "string"));
	} catch {
		return new Set();
	}
}

/** Run all enabled footgun checks against the given file content.
 *  Returns a flat list of findings — one entry per check match. */
export function runFootgunChecks(
	content: string,
	filePath: string,
	disabled: Set<string>,
): FootgunFinding[] {
	const out: FootgunFinding[] = [];
	for (const fg of getEnabledFootguns(disabled)) {
		let matches: InlineMatch[] = [];
		try {
			matches = fg.detect(content, filePath);
		} catch {
			// Detector errors must never break the pipeline — skip and
			// carry on to the next footgun.
			continue;
		}
		for (const m of matches) {
			out.push({
				id: fg.id,
				library: fg.library,
				name: fg.name,
				match: m,
				fixInstruction: fg.fixInstruction,
			});
		}
	}
	return out;
}
