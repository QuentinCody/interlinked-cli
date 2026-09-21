// ===========================================
// Rules fingerprint — "which rules judged this report?"
// ===========================================
// A machine report (`verify --json`, `metrics score --json`) is only comparable
// with another when the same rules produced both. Every ratchet reads a
// repo-local water-line the gated agent can edit, so the report must carry a
// hash of the EFFECTIVE rule set: resolved metric caps, the merged guard-rules
// config (built-in + team + local + mode preset), the line-cap baseline, and
// the verify suppressions. Two reports with equal `rules_hash` were judged by
// the same rules; a differing hash says the rules moved between runs.
//
// Adapted from valknut's `run.config_hash` (io/agent_report.rs, intake
// docs/external-pulse/valknut.md §7). Canonical JSON so key order in a rules
// file cannot change the hash. Pure over the filesystem: no git, no network.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadLargeFileBaseline } from "../harness/large-file-policy.js";
import { resolveMetricCaps } from "../harness/metric-caps.js";
import { loadRules } from "../harness/rules-loader.js";
import { loadSuppressionFile } from "../harness/suppressions.js";
import { canonicalJson } from "./audit-chain.js";

/** Bump when the set of hashed inputs changes, so old and new hashes never compare equal by accident. */
export const RULES_FINGERPRINT_SCHEMA = "interlinked.rules/1";

export interface RulesFingerprint {
	schema: typeof RULES_FINGERPRINT_SCHEMA;
	/** `sha256:<hex>` over the canonical JSON of every input below plus the merged guard config. */
	rules_hash: string;
	/** The human-readable part of what was hashed; the guard config itself is too large to echo. */
	inputs: {
		metric_caps: ReturnType<typeof resolveMetricCaps>;
		/** Grandfathered line-cap entries, or null when no baseline file exists. */
		large_files_grandfathered: number | null;
		guard_rules_files: { team: boolean; local: boolean };
		/** File-level verify suppression entries across all files. */
		suppressions: number;
	};
}

/**
 * A directory is a rules root when it holds `.interlinked/` AND is a project
 * (a `.git` entry or a committed `.interlinked/config.json`). The second
 * condition matters: the harness drops artifact-only `.interlinked/` dirs
 * (`verify-runs.jsonl`) under subtrees it has checked — nine of them in this
 * tree — and a plain "nearest `.interlinked/`" walk stopped at `src/lib/`.
 */
function isRulesRoot(dir: string): boolean {
	const interlinkedDir = join(dir, ".interlinked");
	if (!existsSync(interlinkedDir)) return false;
	return existsSync(join(dir, ".git")) || existsSync(join(interlinkedDir, "config.json"));
}

/**
 * The rules live at the nearest rules root at or above `start`. A verify run
 * targeted at a subdirectory must still be fingerprinted against the repo's
 * rules, not against the defaults a rules-less subtree resolves to (found
 * live 2026-09-21: `verify --json src/lib/metrics` reported cap 25 while
 * `.interlinked/metric-caps.json` said 16). Falls back to `start`.
 */
export function findRulesRoot(start: string): string {
	let dir = resolve(start);
	for (;;) {
		if (isRulesRoot(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(start);
		dir = parent;
	}
}

function countSuppressions(cwd: string): number {
	const file = loadSuppressionFile(join(cwd, ".interlinked"));
	return Object.values(file).reduce((sum, byCheck) => sum + Object.keys(byCheck).length, 0);
}

/** Compute the fingerprint for the rules root at or above `start`. Never throws: an unreadable rules file resolves to its default. */
export function computeRulesFingerprint(start: string): RulesFingerprint {
	const cwd = findRulesRoot(start);
	const baseline = loadLargeFileBaseline(cwd);
	const metricCaps = resolveMetricCaps(cwd, baseline ? { max_lines: baseline.max_lines } : {});
	const interlinkedDir = join(cwd, ".interlinked");
	const inputs: RulesFingerprint["inputs"] = {
		metric_caps: metricCaps,
		large_files_grandfathered: baseline ? Object.keys(baseline.files).length : null,
		guard_rules_files: {
			team: existsSync(join(interlinkedDir, "guard-rules.json")),
			local: existsSync(join(interlinkedDir, "guard-rules.local.json")),
		},
		suppressions: countSuppressions(cwd),
	};
	const payload = canonicalJson({
		schema: RULES_FINGERPRINT_SCHEMA,
		inputs,
		large_files: baseline,
		guard_rules: loadRules(cwd),
		suppressions: loadSuppressionFile(interlinkedDir),
	});
	const hex = createHash("sha256").update(payload).digest("hex");
	return { schema: RULES_FINGERPRINT_SCHEMA, rules_hash: `sha256:${hex}`, inputs };
}
