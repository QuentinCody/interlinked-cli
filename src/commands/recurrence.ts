// ===========================================
// interlinked recurrence — surface repeating agent behaviors
// ===========================================
//
// Subcommands:
//   list              tabular view of aggregated recurrences
//   detail <sig>      every event for one signature
//   flag <sig>        record a harness_missed event (manual flag)
//   scan              walk the working tree, optionally record codebase_existing
//   propose <sig>     print the suggested action (ratchet / scaffold_rule / cleanup_pr)
//
// Output modes follow the existing CLI convention: --json, --short, --full
// (handled via the shared `getOutputMode` / `output` helpers).

import {
	aggregateRecurrences,
	iterateRecurrenceEvents,
	proposeAction,
	type Recurrence,
	type RecurrenceEvent,
	type RecurrenceFilters,
	type RecurrenceKind,
	recordHarnessMissed,
	resolveSinceCutoff,
} from "../harness/recurrence.js";
import { scanCodebaseForRecurrences } from "../harness/recurrence-scanner.js";

interface CommonOpts {
	cwd?: string;
	json?: boolean;
}

interface ListOpts extends CommonOpts {
	kind?: string;
	top?: string;
	since?: string;
	agentSource?: string;
	checkId?: string;
}

interface FlagOpts extends CommonOpts {
	message?: string;
	checkId?: string;
	file?: string;
}

interface ScanOpts extends CommonOpts {
	root?: string[];
	record?: boolean;
}

const KNOWN_KINDS = new Set<string>([
	"harness_caught",
	"harness_missed",
	"codebase_existing",
	"tool_failure",
]);

function isRecurrenceKind(value: string | undefined): value is RecurrenceKind {
	return value !== undefined && KNOWN_KINDS.has(value);
}

function buildFilters(opts: ListOpts): RecurrenceFilters {
	const filters: RecurrenceFilters = {};
	if (isRecurrenceKind(opts.kind)) filters.kind = opts.kind;
	if (opts.agentSource) filters.agent_source = opts.agentSource;
	if (opts.checkId) filters.check_id = opts.checkId;
	const cutoff = resolveSinceCutoff(opts.since);
	if (cutoff) filters.since = cutoff;
	return filters;
}

function loadAndAggregate(opts: ListOpts): Recurrence[] {
	const events = iterateRecurrenceEvents(opts.cwd ?? process.cwd());
	const rows = aggregateRecurrences(events, buildFilters(opts));
	const top = opts.top ? Number.parseInt(opts.top, 10) : undefined;
	return top && Number.isFinite(top) && top > 0 ? rows.slice(0, top) : rows;
}

function ageString(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const sec = Math.floor(ms / 1_000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.floor(hr / 24);
	return `${day}d`;
}

function renderRow(r: Recurrence): string {
	const sources = r.agent_sources.length > 0 ? r.agent_sources.join("/") : "—";
	const last = ageString(r.last_seen);
	return [
		String(r.count).padStart(4),
		r.kind.padEnd(18),
		(r.check_id ?? "—").padEnd(28),
		sources.padEnd(18),
		`${r.distinct_sessions}s/${r.distinct_files}f`.padEnd(10),
		`${last} ago`,
	].join("  ");
}

export async function recurrenceListCommand(opts: ListOpts): Promise<void> {
	const rows = loadAndAggregate(opts);
	if (opts.json) {
		console.log(JSON.stringify(rows));
		return;
	}
	if (rows.length === 0) {
		console.log("(no recurrences yet — run `interlinked recurrence scan` or wait for harness events)");
		return;
	}
	console.log(
		`${"COUNT".padStart(4)}  ${"KIND".padEnd(18)}  ${"CHECK".padEnd(28)}  ${"AGENTS".padEnd(18)}  ${"SCOPE".padEnd(10)}  LAST`,
	);
	for (const r of rows) console.log(renderRow(r));
	console.log("");
	console.log(`(${rows.length} row(s); run \`interlinked recurrence detail <signature>\` for breakdown)`);
}

export async function recurrenceDetailCommand(
	signature: string,
	opts: CommonOpts,
): Promise<void> {
	const events = iterateRecurrenceEvents(opts.cwd ?? process.cwd());
	const matching: RecurrenceEvent[] = [];
	for (const event of events) if (signatureOf(event) === signature) matching.push(event);
	if (opts.json) {
		console.log(JSON.stringify(matching));
		return;
	}
	if (matching.length === 0) {
		console.error(`No events found for signature: ${signature}`);
		console.error("(run `interlinked recurrence list` to see known signatures)");
		return;
	}
	console.log(`Signature: ${signature}`);
	console.log(`Total events: ${matching.length}`);
	console.log("");
	for (const e of matching) {
		const file = e.file ?? "—";
		const session = e.session_id ?? "—";
		const agent = e.agent_source ?? "—";
		console.log(`  ${e.ts}  ${agent.padEnd(8)}  ${session.padEnd(12)}  ${file}`);
		if (e.message) console.log(`    ${e.message}`);
	}
}

/** Same shape as recurrence.ts's deriveSignature. Inlined here to avoid
 *  importing a single-purpose helper across module boundaries; kept in
 *  sync via __tests__/recurrence-cli signature-match assertions. */
function signatureOf(event: RecurrenceEvent): string {
	if (event.kind === "harness_caught") {
		return `harness_caught:${event.check_id ?? "unknown"}:${event.agent_source ?? "unknown"}`;
	}
	if (event.kind === "codebase_existing") {
		return `codebase_existing:${event.check_id ?? "unknown"}`;
	}
	return `harness_missed:${event.signature ?? event.message ?? "untagged"}`;
}

export async function recurrenceFlagCommand(
	signature: string,
	opts: FlagOpts,
): Promise<void> {
	if (!signature) {
		console.error("Usage: interlinked recurrence flag <signature> [--message ...]");
		return;
	}
	recordHarnessMissed({
		signature,
		...(opts.checkId !== undefined ? { check_id: opts.checkId } : {}),
		...(opts.file !== undefined ? { file: opts.file } : {}),
		...(opts.message !== undefined ? { message: opts.message } : {}),
		cwd: opts.cwd ?? process.cwd(),
	});
	if (opts.json) {
		console.log(JSON.stringify({ ok: true, signature }));
		return;
	}
	console.log(`Flagged harness_missed: ${signature}`);
}

export async function recurrenceScanCommand(opts: ScanOpts): Promise<void> {
	const findings = scanCodebaseForRecurrences({
		cwd: opts.cwd ?? process.cwd(),
		...(opts.root !== undefined ? { roots: opts.root } : {}),
		recordEvents: opts.record === true,
	});
	if (opts.json) {
		console.log(JSON.stringify(findings));
		return;
	}
	if (findings.length === 0) {
		console.log("(scan found no codebase_existing patterns)");
		return;
	}
	const byCheck = new Map<string, number>();
	for (const f of findings) byCheck.set(f.check_id, (byCheck.get(f.check_id) ?? 0) + 1);
	console.log(`Scanned ${findings.length} finding(s) across ${byCheck.size} check(s):`);
	for (const [check, count] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${String(count).padStart(4)}  ${check}`);
	}
	if (opts.record) {
		console.log("");
		console.log("Recorded as codebase_existing events. View with `interlinked recurrence list --kind codebase_existing`.");
	} else {
		console.log("");
		console.log("(dry run — pass --record to append codebase_existing events)");
	}
}

export async function recurrenceProposeCommand(
	signature: string,
	opts: CommonOpts,
): Promise<void> {
	const events = iterateRecurrenceEvents(opts.cwd ?? process.cwd());
	const rows = aggregateRecurrences(events);
	const row = rows.find((r: Recurrence) => r.signature === signature);
	if (!row) {
		console.error(`No recurrence row found for signature: ${signature}`);
		return;
	}
	const action = proposeAction(row);
	if (opts.json) {
		console.log(JSON.stringify({ row, action }));
		return;
	}
	console.log(`Action: ${action.kind}`);
	console.log(`  ${action.headline}`);
	console.log("");
	console.log(action.detail);
}
