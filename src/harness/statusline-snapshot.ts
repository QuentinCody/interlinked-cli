// ===========================================
// Statusline Snapshot Writer
// ===========================================
// Writes pre-computed state for the bash status-line script to read on
// each render. Two outputs:
//   .interlinked/statusline.snapshot   — key=value pairs (one per line)
//   .interlinked/loaded-rules.md       — effective merged ruleset, sorted
// The bash script (see writeStatuslineScript in src/lib/hook-installers.ts)
// does pure formatting; all the math lives here.

import { renameSync, writeFileSync } from "node:fs";
import { readJsonFile } from "../lib/json-file.js";
import { join } from "node:path";
import { updateEnforcementLedger } from "./enforcement-ledger.js";
import { crapThresholdFor, maxCyclomaticFor, maxFunctionTokensFor } from "./metric-caps.js";
import { BUILTIN_RULES } from "./rules/builtin-rules.js";
import {
	buildLoadedChecksMarkdown,
	buildLoadedRulesMarkdown,
	countChecks,
} from "./statusline-snapshot-checks-markdown.js";
import type { GuardRulesConfig } from "./types.js";

export interface StatuslineSnapshotInput {
	/** Project root — directory that owns `.interlinked/`. */
	cwd: string;
	/** Path to the `.interlinked/` directory. */
	interlinkedDir: string;
	/** Live merged guard-rules config from `loadRules()`. */
	rules: GuardRulesConfig;
	/** Count of currently held file reservations. */
	reservationsCount: number;
	/** Trigram index status: ready / stale / missing. */
	indexStatus: "ready" | "stale" | "missing";
	/** Indexed file count when the trigram index is loaded; 0 otherwise. */
	indexFiles: number;
	/** True when the server bridge is connected. */
	serverBridgeConnected: boolean;
	/**
	 * PID of the harness process writing this snapshot. Surfaced in the
	 * status line so a screenshot identifies *which* daemon produced the
	 * counters — confirms freshness when the user has just rebuilt or
	 * restarted. Defaults to `process.pid` at the call site; pinned via
	 * input rather than read inside this module so the snapshot writer
	 * stays a pure function of its inputs (and is testable without
	 * mocking `process`).
	 */
	daemonPid: number;
	/**
	 * Spec-substrate state for the statusline's spec segment (§11.1 of
	 * docs/design/spec-audit-runtime-checks.md). Optional — a daemon that
	 * hasn't built a spec ledger yet omits them and the bash script degrades
	 * to `spec off`.
	 */
	specFactsTotal?: number | undefined;
	/** Ingested review findings still open (neither touched nor acked). */
	reviewFindingsOpen?: number | undefined;
	/**
	 * Guard activity since daemon start — blocks, warnings, asks. Optional so a
	 * caller that has not wired the tally still writes a valid snapshot (the
	 * fields render as zeros and the segment hides itself).
	 */
	guardTally?:
		| { blocked: number; warned: number; asked: number; lastBlockRule: string | null }
		| undefined;
}

interface PersistedConfigShape {
	mode?: unknown;
	active_server?: unknown;
	sync_mode?: unknown;
	workspace_id?: unknown;
	servers?: Record<string, { workspace_id?: unknown }>;
}

interface CheckPolicyShape {
	mode?: unknown;
}

/**
 * Write the statusline snapshot plus the two click-target markdown files
 * the bash script's OSC 8 hyperlinks point to:
 *
 *   .interlinked/statusline.snapshot   — key=value state for the script
 *   .interlinked/loaded-rules.md       — what the "N rules" segment links to
 *   .interlinked/loaded-checks.md      — what the "N checks" segment links to
 *
 * Best-effort: any I/O failure is swallowed. The bash script's fallback
 * path handles missing/stale snapshots.
 */
export function writeStatuslineArtifacts(input: StatuslineSnapshotInput): void {
	try {
		atomicWrite(join(input.interlinkedDir, "statusline.snapshot"), buildSnapshot(input));
	} catch (e) {
		void e;
	}
	try {
		atomicWrite(
			join(input.interlinkedDir, "loaded-rules.md"),
			buildLoadedRulesMarkdown(input.rules),
		);
	} catch (e) {
		void e;
	}
	try {
		atomicWrite(
			join(input.interlinkedDir, "loaded-checks.md"),
			buildLoadedChecksMarkdown(input.rules),
		);
	} catch (e) {
		void e;
	}
}

/** Lifetime enforcement totals, or zeroes if the ledger cannot be read. */
function safeWork(interlinkedDir: string): { blocked: number; caught: number; evaluated: number } {
	try {
		return updateEnforcementLedger(interlinkedDir, new Date().toISOString());
	} catch (err) {
		void err; // the snapshot is still worth writing without the counters
		return { blocked: 0, caught: 0, evaluated: 0 };
	}
}

/** Effective metric caps, or 0 (rendered as "off") when unreadable. */
function safeCaps(interlinkedDir: string): { cyclomatic: number; crap: number; functionTokens: number } {
	try {
		const root = interlinkedDir.replace(/[/\\]\.interlinked[/\\]?$/, "");
		return {
			cyclomatic: maxCyclomaticFor(root),
			crap: crapThresholdFor(root),
			functionTokens: maxFunctionTokensFor(root),
		};
	} catch (err) {
		void err;
		return { cyclomatic: 0, crap: 0, functionTokens: 0 };
	}
}

function buildSnapshot(input: StatuslineSnapshotInput): string {
	const modes = readModes(input.interlinkedDir);
	const counts = countRules(input.rules);
	const toggles = readToggles(input.rules);

	const checks = countChecks(input.rules);
	// WORK DONE, alongside the inventory. Both are best-effort: a counter must
	// never be the reason a snapshot fails to write.
	const work = safeWork(input.interlinkedDir);
	const caps = safeCaps(input.interlinkedDir);

	const rows: string[] = [
		`harness_mode=${modes.harness}`,
		`enforcement_mode=${modes.enforcement}`,
		`sync_mode=${modes.sync}`,
		`active_server=${modes.activeServer}`,
		`workspace_id=${modes.workspaceId}`,
		`rules_total=${input.rules.rules.length}`,
		`rules_disabled=${counts.disabled}`,
		`rules_custom=${counts.custom}`,
		// Split: tool runners (subprocess wrappers like tsc/biome/gitleaks)
		// vs inline detectors (in-process regex/AST checks from CHECK_REGISTRY
		// + the inline entries in `quality_checks` that lack a `command`).
		// `checks_enabled` is preserved as the sum for one release window so
		// any out-of-band consumer of the snapshot keeps working.
		`tool_checks_enabled=${checks.tools}`,
		`inline_checks_enabled=${checks.inline}`,
		`checks_enabled=${checks.tools + checks.inline}`,
		// What the harness actually DID since this daemon started. The counts
		// above describe the harness's SIZE, which a human learns once; these
		// change every few tool calls and are the product's visible value.
		`guard_blocked=${input.guardTally?.blocked ?? 0}`,
		`guard_warned=${input.guardTally?.warned ?? 0}`,
		`guard_asked=${input.guardTally?.asked ?? 0}`,
		`guard_last_block_rule=${input.guardTally?.lastBlockRule ?? ""}`,
		`reservations_count=${input.reservationsCount}`,
		`index_status=${input.indexStatus}`,
		`index_files=${input.indexFiles}`,
		`classifier_enabled=${toggles.classifier}`,
		`scanner_enabled=${toggles.scanner}`,
		`auto_coordination=${toggles.autoCoord}`,
		`server_bridge=${input.serverBridgeConnected ? "connected" : "local_only"}`,
		`daemon_pid=${input.daemonPid}`,
		// Spec substrate (§11.1): -1 = ledger not built yet (bash → "spec off").
		`spec_facts_total=${input.specFactsTotal ?? -1}`,
		`review_findings_open=${input.reviewFindingsOpen ?? 0}`,
		// Lifetime totals for this attachment, monotonic by construction, folded
		// incrementally from a byte cursor (never a full read of activity.jsonl).
		// These are what the harness has DONE here, as opposed to what it ships.
		`lifetime_blocked=${work.blocked}`,
		`lifetime_caught=${work.caught}`,
		`lifetime_evaluated=${work.evaluated}`,
		// Caps TIGHTEN over time (cyclomatic 25 -> 22, CRAP 30 -> 25), so a FALLING
		// number here is progress; the statusline renders them as `cc<=N` so the
		// direction reads correctly to someone glancing at it.
		`cap_cyclomatic=${caps.cyclomatic}`,
		`cap_crap=${caps.crap}`,
		`cap_function_tokens=${caps.functionTokens}`,
		`generated_at=${new Date().toISOString()}`,
	];
	return `${rows.join("\n")}\n`;
}

interface ResolvedModes {
	harness: string;
	enforcement: string;
	sync: string;
	activeServer: string;
	workspaceId: string;
}

function readModes(interlinkedDir: string): ResolvedModes {
	const shared = readJsonFile<PersistedConfigShape>(join(interlinkedDir, "config.json"));
	const local = readJsonFile<PersistedConfigShape>(join(interlinkedDir, "config.local.json"));
	const policy = readJsonFile<CheckPolicyShape>(join(interlinkedDir, "check-policy.json"));

	const activeServer = nonEmptyString(local?.active_server) ?? "";
	const serverEntry = activeServer ? local?.servers?.[activeServer] : undefined;
	const workspaceId =
		nonEmptyString(serverEntry?.workspace_id) ?? nonEmptyString(local?.workspace_id) ?? "";

	return {
		harness: nonEmptyString(shared?.mode) ?? "quality",
		enforcement: nonEmptyString(policy?.mode) ?? "balanced",
		sync: nonEmptyString(local?.sync_mode) ?? "realtime",
		activeServer,
		workspaceId,
	};
}

interface RuleCounts {
	custom: number;
	disabled: number;
}

function countRules(rules: GuardRulesConfig): RuleCounts {
	const builtinIds = new Set(BUILTIN_RULES.map((r) => r.id));
	return {
		custom: rules.rules.filter((r) => !builtinIds.has(r.id)).length,
		disabled: (rules.disabled_rules ?? []).length,
	};
}

interface ToggleState {
	classifier: "enabled" | "disabled";
	scanner: "enabled" | "disabled";
	autoCoord: "on" | "off";
}

function readToggles(rules: GuardRulesConfig): ToggleState {
	return {
		classifier: rules.policy_classifier?.enabled ? "enabled" : "disabled",
		scanner: rules.content_scanner?.enabled ? "enabled" : "disabled",
		autoCoord: rules.auto_coordination?.enabled === false ? "off" : "on",
	};
}

function nonEmptyString(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function atomicWrite(path: string, content: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}
