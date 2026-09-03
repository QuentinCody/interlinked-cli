// ===========================================
// interlinked audit — verify the hash-chained guard-decision log
// ===========================================
// Borrowed from Microsoft Agent Governance Toolkit's audit pattern
// (`agent-governance-claude-code/lib/audit.mjs`, MIT). Maps to OWASP
// ASI11 "Agent Untraceability" — tamper-evident decision audit.
//
// The hash chain itself lives in two places:
//   - writer: src/lib/hook-template-chunks/session-state.ts::appendGuardDecision
//   - verifier: src/lib/audit-chain.ts::verifyAuditChainStreaming
// This file is the CLI surface; it dispatches to the verifier and formats
// results. Stays small so policy/format decisions don't drift.

import type { OptionValues } from "commander";
import { verifyAuditChainStreaming } from "../lib/audit-chain.js";
import { c } from "../lib/formatter.js";

function printAuditText(
	result: Awaited<ReturnType<typeof verifyAuditChainStreaming>>,
	coveragePct: number | null,
): void {
	const status = result.valid ? c.green("VALID") : c.red("TAMPERED");
	console.log(c.bold("Audit Chain Verification"));
	console.log(`Status:                ${status}`);
	console.log(`Total events:          ${result.total_events.toLocaleString()}`);
	console.log(
		`Guard decision events: ${result.guard_events.toLocaleString()}  (${coveragePct ?? 0}% hash-chained)`,
	);
	console.log(`Chained events:        ${result.chained_events.toLocaleString()}`);
	if (result.unchained_guard_events > 0) {
		console.log(
			`${c.yellow("Legacy / unchained:")}    ${result.unchained_guard_events.toLocaleString()}  (written before the chain shipped)`,
		);
	}
	if (result.last_hash) {
		console.log(`Last hash:             ${result.last_hash.slice(0, 16)}…`);
	}
	if (!result.valid && result.first_bad_reason) {
		console.log(c.red("\nTamper detected:"));
		console.log(`  Chained event #${result.first_bad_index}`);
		if (result.first_bad_line_number) {
			console.log(`  activity.jsonl line ${result.first_bad_line_number}`);
		}
		console.log(`  Reason: ${result.first_bad_reason}`);
		console.log(
			c.dim(
				"\nOWASP ASI11 (Agent Untraceability) — re-snapshotting from the last\nknown-good hash is the recovery path. Investigate writes to\n.interlinked/activity.jsonl between then and now.",
			),
		);
	} else if (result.valid && result.chained_events > 0) {
		console.log(
			c.dim("OWASP ASI11 (Agent Untraceability) — chain intact, no rewrites detected."),
		);
	} else if (result.guard_events === 0) {
		console.log(
			c.dim("No guard decision events yet — run a session to populate the chain."),
		);
	}
}

export async function auditVerifyCommand(opts: OptionValues): Promise<void> {
	const cwd = typeof opts.cwd === "string" ? opts.cwd : process.cwd();
	const isJson = Boolean(opts.json);
	const result = await verifyAuditChainStreaming(cwd);

	const data = {
		valid: result.valid,
		total_events: result.total_events,
		guard_events: result.guard_events,
		chained_events: result.chained_events,
		unchained_guard_events: result.unchained_guard_events,
		first_bad_index: result.first_bad_index,
		first_bad_line_number: result.first_bad_line_number,
		first_bad_reason: result.first_bad_reason,
		last_hash: result.last_hash,
		coverage_pct:
			result.guard_events > 0
				? Math.round((result.chained_events / result.guard_events) * 100)
				: null,
	};

	if (isJson) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		printAuditText(result, data.coverage_pct);
	}

	if (!result.valid) {
		process.exitCode = 1;
	}
}
