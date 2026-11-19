// ===========================================
// Observability-log registrars — append-only state inspection: recurrence
// aggregation, trajectory snapshots/replay, the hash-chained audit log,
// captured agent plans, cloud-governor verdicts, and the TDD obligation
// ledger (debt). Views over locally-recorded JSONL streams; the only writers
// are explicit human actions (recurrence flag / scan --record, debt resolve).
// ===========================================

import { type Command, type OptionValues } from "commander";

export function registerObservabilityLogCommands(program: Command): void {
	registerRecurrence(program);
	registerTrajectory(program);
	registerAudit(program);
	registerPlan(program);
	registerCloud(program);
	registerTdd(program);
	registerDebt(program);
	registerQuery(program);
}

function registerRecurrence(program: Command): void {
	// ===========================================
	// recurrence — surface repeating agent behaviors (Lopopolo "garbage-
	// collect AI slop" + Bitar "structurally impossible" framing). Three
	// kinds: harness_caught (already enforced, ratchet candidate),
	// harness_missed (slipped past, scaffold a rule), codebase_existing
	// (pre-existing replications, cleanup PR candidate).
	// ===========================================
	const recCmd = program
		.command("recurrence")
		.description("Surface repeating agent behaviors (harness_caught / harness_missed / codebase_existing / tool_failure)");

	recCmd
		.command("list")
		.description("Show aggregated recurrence rows (top by count, newest tiebreak)")
		.option("--kind <kind>", "Filter by kind (harness_caught | harness_missed | codebase_existing | tool_failure)")
		.option("--top <n>", "Limit to top N rows by count")
		.option("--since <duration>", "Only include events at-or-after (e.g. 7d, 12h, ISO timestamp)")
		.option("--agent-source <name>", "Filter by agent_source (claude/copilot/codex/gemini/cursor/opencode/pi)")
		.option("--check-id <id>", "Filter by check_id")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { recurrenceListCommand } = await import("../commands/recurrence.js");
			await recurrenceListCommand(opts);
		});

	recCmd
		.command("detail <signature>")
		.description("List every event for one recurrence signature")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (signature: string, opts: OptionValues) => {
			const { recurrenceDetailCommand } = await import("../commands/recurrence.js");
			await recurrenceDetailCommand(signature, opts);
		});

	recCmd
		.command("flag <signature>")
		.description("Record a harness_missed event — pattern observed without a rule firing")
		.option("--message <text>", "Human-readable detail")
		.option("--check-id <id>", "Check id this should have caught (if known)")
		.option("--file <path>", "File where the pattern was seen")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (signature: string, opts: OptionValues) => {
			const { recurrenceFlagCommand } = await import("../commands/recurrence.js");
			await recurrenceFlagCommand(signature, opts);
		});

	recCmd
		.command("scan")
		.description("Walk the working tree, run inline detectors, optionally record codebase_existing events")
		.option("--root <dir...>", "Subdirectories to scan (default: src)")
		.option("--record", "Append codebase_existing events (default: dry run)")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { recurrenceScanCommand } = await import("../commands/recurrence.js");
			await recurrenceScanCommand(opts);
		});

	recCmd
		.command("propose <signature>")
		.description("Print the suggested action for a recurrence (ratchet / scaffold_rule / cleanup_pr)")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (signature: string, opts: OptionValues) => {
			const { recurrenceProposeCommand } = await import("../commands/recurrence.js");
			await recurrenceProposeCommand(signature, opts);
		});
}

function registerTrajectory(program: Command): void {
	// ===========================================
	// interlinked trajectory — inspect session trajectory state and replay
	// recorded event streams through the sequence-detector framework. See
	// docs/design/trajectory-detectors-implementation-plan.md §2.3.
	// ===========================================
	const trajCmd = program
		.command("trajectory")
		.description("Inspect trajectory snapshots; replay recorded event streams through sequence detectors");

	trajCmd
		.command("list")
		.description("Enumerate trajectory snapshots in .interlinked/sessions/")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { trajectoryListCommand } = await import("../commands/trajectory.js");
			await trajectoryListCommand(opts);
		});

	trajCmd
		.command("show")
		.description("Show one trajectory snapshot (latest by default)")
		.option("--session <id>", "Specific session_id to show")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { trajectoryShowCommand } = await import("../commands/trajectory.js");
			await trajectoryShowCommand(opts);
		});

	trajCmd
		.command("replay <file>")
		.description("Replay a JSONL event stream through the sequence-detector framework")
		.option("--check <id>", "Restrict to a single detector id")
		.option("--phase <phase>", "Restrict to one phase: pre_block | pre_warn | stop")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (file: string, opts: OptionValues) => {
			const { trajectoryReplayCommand } = await import("../commands/trajectory.js");
			await trajectoryReplayCommand({ ...opts, file });
		});
}

function registerAudit(program: Command): void {
	// ===========================================
	// interlinked audit — verify the hash-chained guard-decision log.
	// Borrowed from Microsoft Agent Governance Toolkit's audit.mjs pattern;
	// maps to OWASP ASI11 "Agent Untraceability". See docs/design/
	// agt-cloud-tier-adoptions.md for the broader framing.
	// ===========================================
	const auditCmd = program
		.command("audit")
		.description("Verify tamper-evidence of the guard-decision audit chain in activity.jsonl");

	auditCmd
		.command("verify")
		.description("Walk the hash chain forward, report the first integrity failure (OWASP ASI11)")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { auditVerifyCommand } = await import("../commands/audit.js");
			await auditVerifyCommand(opts);
		});
}

function registerPlan(program: Command): void {
	// ===========================================
	// plan — show agent-emitted plans captured at PreToolUse / UserPromptSubmit.
	// Data capture only (no evaluation); see src/harness/plan-capture.ts.
	// ===========================================
	const planCmd = program
		.command("plan")
		.description("Show agent-emitted plans captured from TaskCreate / ExitPlanMode / structured prompts");

	planCmd
		.command("list", { isDefault: true })
		.description("Show the 20 most recent CapturedPlans (newest first)")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { planListCommand } = await import("../commands/plan.js");
			await planListCommand(opts);
		});

	planCmd
		.command("show <session_id>")
		.description("Pretty-print the most recent captured plan for a session")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (sessionId: string, opts: OptionValues) => {
			const { planShowCommand } = await import("../commands/plan.js");
			await planShowCommand(sessionId, opts);
		});
}

function registerCloud(program: Command): void {
	const cloudCmd = program
		.command("cloud")
		.description("Inspect the cloud governor (reads cloud_governor from config.local.json)");

	cloudCmd
		.command("recent")
		.description("Show recent events + verdicts recorded by the cloud governor")
		.option("--limit <n>", "How many events to show (default 20, max 200)", "20")
		.option("--json", "Machine-readable output")
		.option("--cwd <path>", "Project root (default: current directory)")
		.action(async (opts: { limit?: string; json?: boolean; cwd?: string }) => {
			const parsedLimit = Number.parseInt(opts.limit ?? "20", 10);
			const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
			const { cloudRecentCommand } = await import("../commands/cloud.js");
			await cloudRecentCommand({
				cwd: opts.cwd || process.cwd(),
				limit,
				...(opts.json !== undefined ? { json: opts.json } : {}),
			});
		});
}

function registerTdd(program: Command): void {
	// ===========================================
	// tdd — inspect and clear TDD cycle state. The commit gate blocks on
	// REMEMBERED cycle state and nothing re-measures the tree at decision
	// time; when that memory went wrong (2026-07-26) it refused every commit
	// for hours against a green suite, with no way to see what it believed or
	// to correct it. A gate that can wedge needs an inspection and reset path.
	// ===========================================
	const tddCmd = program
		.command("tdd")
		.description("Inspect and clear TDD cycle state (what the commit gate believes)");

	tddCmd
		.command("status")
		.description("Show tracked cycles: state, how old each red is, and the run that set it")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Every cycle, not just the blocking ones")
		.action(async (opts: OptionValues) => {
			const { tddStatusCommand } = await import("../commands/tdd.js");
			await tddStatusCommand(opts);
		});

	tddCmd
		.command("clear [file]")
		.description(
			"Drop a wedged cycle (or all of them). The commit gate re-measures on the next test run, so a genuinely failing file reds again",
		)
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (file: string | undefined, opts: OptionValues) => {
			const { tddClearCommand } = await import("../commands/tdd.js");
			await tddClearCommand(file, opts);
		});
}

function registerDebt(program: Command): void {
	// ===========================================
	// debt — inspect the pair-scoped TDD obligation ledger
	// (.interlinked/obligations.jsonl): open coverage / red_suite debts, the
	// per-file transition history, and a human-override resolve. Phase 3 of
	// docs/design/coverage-debt-tdd.md.
	// ===========================================
	const debtCmd = program
		.command("debt")
		.description("Inspect pair-scoped TDD debts (coverage / red_suite) from the obligation ledger");

	debtCmd
		.command("list")
		.description("Show open debts (kind, file, opened-at, session)")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: OptionValues) => {
			const { debtListCommand } = await import("../commands/debt.js");
			await debtListCommand(opts);
		});

	debtCmd
		.command("show <file>")
		.description("Full transition history for one file's obligations")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (file: string, opts: OptionValues) => {
			const { debtShowCommand } = await import("../commands/debt.js");
			await debtShowCommand(file, opts);
		});

	debtCmd
		.command("resolve <file>")
		.description(
			"Discharge every open debt on a file (human override — the commit gate remains the ground-truth backstop)",
		)
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (file: string, opts: OptionValues) => {
			const { debtResolveCommand } = await import("../commands/debt.js");
			await debtResolveCommand(file, opts);
		});
}

function registerQuery(program: Command): void {
	// ===========================================
	// query — bounded filter/aggregate surface over the .interlinked JSONL
	// logs: the read verb the append-only logs lacked. Named sources carry an
	// identity filter + display defaults; any .jsonl path works too. Scans are
	// budgeted (newest-N records / MB tail) so the 400 MB logs stay safe to
	// query. No positional prints the source catalog.
	// ===========================================
	program
		.command("query [source]")
		.description(
			"Bounded query over .interlinked JSONL logs (blocks/checks/recurrences/costs/… or a .jsonl path)",
		)
		.option(
			"--where <expr...>",
			"Filter: key=value | key!=v | key~=substr | key>n (AND; dot paths fan out over arrays)",
		)
		.option("--fields <csv>", "Columns to display (dot paths)")
		.option("--actions", "Project selected checks records as historical actions; revalidate before acting")
		.option("--by <path>", "Aggregate: count records per value of <path>")
		.option("--sum <path>", "With --by: sum this numeric field per group")
		.option("--since <dur|iso>", "Only records at/after (30m, 2h, 7d, or an ISO timestamp)")
		.option("--limit <n>", "Rows to display (default 20)")
		.option("--last <n>", "Scan at most the newest N records (default 20000)")
		.option("--max-mb <mb>", "Scan at most this many MB from the tail (default 64)")
		.option("--file <path>", "Query an explicit JSONL file path")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.option("--short", "Rows only, no footer")
		.option("--full", "No cell truncation")
		.action(async (source: string | undefined, opts: OptionValues) => {
			const { queryCommand } = await import("../commands/query.js");
			await queryCommand(source, opts);
		});
}
