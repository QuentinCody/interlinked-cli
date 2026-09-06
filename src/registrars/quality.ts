// ===========================================
// Quality & edit registrars — code-quality gates and gated file mutation:
// structural check, full verify gate, codebase search, atomic multi-edit /
// gated write, artifact-structure management, and the coverage / mutation
// per-file ratchets.
// ===========================================

import { type Command, type OptionValues } from "commander";
import { registerMetricsCommands } from "./metrics.js";
import { registerMutationCloudCommands } from "./mutation-cloud.js";

const VERIFY_DESCRIPTION =
	"Run the default high-signal external catalog plus diff-safe inline checks. Target can be a local path, GitHub URL, or any git remote URL.";
const VERIFY_ONLY_DESCRIPTION =
	"Run one named external check (for example: tsc, biome, oxlint, eslint, semgrep, gitleaks, knip, docs-check, sca)";

function registerCheckAndSearchCommands(program: Command): void {
	program
		.command("check")
		.description(
			"Scan project for structural issues and optionally run external tool checks (tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, etc.)",
		)
		.option(
			"--only <check>",
			"Run only a specific check (structural: broken-imports, cycles, duplicates, missing-tests, secrets, any-types, blast-radius, dead-imports; tools: tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, cargo-check, cargo-clippy, go-build, golangci-lint, c-compile, clang-tidy)",
		)
		.option(
			"--tools [list]",
			"Also run external tool checks (comma-separated, or omit for all available)",
		)
		.option("--report", "Show tool coverage/discovery report")
		.option("--json", "Machine-readable output")
		.option("--cwd <path>", "Project root (default: current directory)")
		.action(async (opts: OptionValues) => {
			const { checkCommand } = await import("../commands/check.js");
			await checkCommand(opts);
		});

	program
		.command("search <query>")
		.description("Search the local codebase (ripgrep with native fallback)")
		.option("--path <dir>", "Search root directory (default: cwd)")
		.option("--glob <pattern>", "File glob pattern (e.g. '*.ts')")
		.option("--type <type>", "File type filter for ripgrep (e.g. ts, py, rust)")
		.option("--limit <n>", "Max results (default: 30, max: 200)")
		.option("--context <n>", "Context lines around matches (default: 2)")
		.option("--engine <engine>", "Force engine: ripgrep or native")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Full output with context lines")
		.action(async (query: string, opts: OptionValues) => {
			const { searchCommand } = await import("../commands/search.js");
			await searchCommand(query, opts);
		});
}

function registerMultiEditCommand(program: Command): void {
	program
		.command("multi-edit [path]")
		.description(
			"Apply N old/new string edits atomically to one or more files. Gate runs once on final content. Ambiguity evaluated after prior edits.",
		)
		.option(
			"--stdin",
			"Read a manifest from stdin: {version,batches} for multi-file (no <path> needed), or {version,edits} with <path> for one file. PREFERRED — no temp file.",
		)
		.option(
			"--manifest <file>",
			"Read the same manifest shapes from <file>. Only for a manifest you already have on disk; prefer --stdin.",
		)
		.option("--json", "Machine-readable output (emits the design-doc error-code shape)")
		.action(async (path: string | undefined, opts: OptionValues) => {
			const { multiEditCommand } = await import("../commands/multi-edit.js");
			await multiEditCommand(path, opts);
		});
}

function registerVerifyCommand(program: Command): void {
	program
		.command("verify [target]")
		.description(VERIFY_DESCRIPTION)
		.option("--only <tool>", VERIFY_ONLY_DESCRIPTION)
		.option("--suggestions", "Also run scored regex heuristics (sql-injection, perf, quality)")
		.option("--json", "Machine-readable output")
		.option("--details", "Show per-file details for all findings")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--branch <ref>", "Branch, tag, or commit to check (remote repos)")
		.option("--subdir <path>", "Only scan a subdirectory (useful for monorepos)")
		.option(
			"--skip <checks>",
			"Skip specific checks (comma-separated: semgrep,knip,complexity,silent_catches,...)",
		)
		.option("--suppress <entries...>", "Suppress a finding: file:check or file:check:reason")
		.option("--show-suppressions", "List all active suppressions")
		.option("--structure", "Include generic artifact structure checks")
		.option("--structure-only", "Run only structure checks")
		.option("--adoption-gate", "Fail when adopted categories drop below thresholds")
		.option(
			"--all-checks",
			"Include broad advisory smell checks and dead-code scans in addition to the default high-signal audit",
		)
		.option(
			"--dead-code",
			"Run Supermodel's cloud dead-code analysis (opt-in; requires the `supermodel` CLI)",
		)
		.action(async (target: string | undefined, opts: OptionValues) => {
			const { verifyCommand } = await import("../commands/verify.js");
			await verifyCommand({ ...opts, ...(target !== undefined ? { target } : {}) });
		});
}

function registerWriteCommands(program: Command): void {
	// `interlinked write` routes Bash-mediated file writes through the full
	// content-quality pipeline (pre_block registry, biome diff-overlay, tsc
	// diff-overlay). The Bash pre_block rule BLOCKS naive `node -e
	// fs.writeFileSync(...)` / `cat > file.ts` / `sed -i` / `tee` invocations
	// against tracked source files; this command is the supported escape
	// hatch for coordinated multi-site atomic edits (add an import AND use
	// it in the same landing) that would trip the diff-overlay if staged as
	// two separate Edit calls. See
	// `docs/design/bash-writes-through-content-gates.md`.
	program
		.command("write [path]")
		.description(
			"Write file(s) through the content-quality gate (pre_block + biome + tsc diff-overlay). Supports --stdin, --from-file, and --batch <manifest.json> with rollback protection.",
		)
		.option("--stdin", "Read content from stdin (single-file mode)")
		.option("--from-file <src>", "Read content from a source file (single-file mode)")
		.option(
			"--batch <manifest>",
			"Path to a batch manifest JSON {version:1, writes:[{path,content}]}",
		)
		.option("--unsafe-outside-repo", "Allow writing outside the project root (discouraged)")
		.option("--json", "Machine-readable output")
		.action(async (path: string | undefined, opts: OptionValues) => {
			const { writeCommand } = await import("../commands/write.js");
			await writeCommand(path, opts);
		});

	// `interlinked verify-changeset` — the agent-callable self-gate: preview the
	// enforced content-quality gate over a PROPOSED changeset WITHOUT writing.
	// Preview-not-bypass — reports only; the real Write/Edit gate still enforces.
	program
		.command("verify-changeset")
		.description(
			"Preview the content-quality gate (pre_block + biome + tsc diff-overlay) over a PROPOSED changeset WITHOUT writing — the agent-callable self-gate. Input JSON {version:1, changes:[{path,content}|{path,old_string,new_string}|{path,edits}]} via --file or --stdin.",
		)
		.option("--file <changeset>", "Path to a changeset JSON file")
		.option("--stdin", "Read the changeset JSON from stdin")
		.option("--warnings", "Also surface pre_warn advisories (default: match the enforced gate)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { verifyChangesetCommand } = await import("../commands/verify-changeset.js");
			await verifyChangesetCommand(opts);
		});
}

function registerStructureCommands(program: Command): void {
	// Structure: generic artifact structure management
	const structCmd = program
		.command("structure")
		.description("Generic artifact structure management (manifests, catalogs, adoption)");

	structCmd
		.command("init")
		.description("Create interlinked/structure.json and scaffold artifact files")
		.option("--mode <mode>", "Structure mode: minimal, standard, strict", "standard")
		.option("--with <categories>", "Comma-separated artifact categories to scaffold")
		.option("--write", "Actually write files (default is dry-run)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureInitCommand } = await import("../commands/structure.js");
			await structureInitCommand(opts);
		});

	structCmd
		.command("scan")
		.description("Build or refresh local generated artifact catalogs")
		.option("--full", "Force full rescan")
		.option("--incremental", "Only refresh changed categories")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureScanCommand } = await import("../commands/structure.js");
			await structureScanCommand(opts);
		});

	structCmd
		.command("status")
		.description("Show adoption coverage, cache staleness, and invalid references")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureStatusCommand } = await import("../commands/structure.js");
			await structureStatusCommand(opts);
		});

	structCmd
		.command("accept")
		.description("Promote extracted findings into committed artifact files")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureAcceptCommand } = await import("../commands/structure.js");
			await structureAcceptCommand(opts);
		});

	structCmd
		.command("doctor")
		.description("Validate structure files, cache freshness, and cross-references")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureDoctorCommand } = await import("../commands/structure.js");
			await structureDoctorCommand(opts);
		});

	structCmd
		.command("baseline <action>")
		.description("Manage structure baselines (save, clear, status)")
		.option("--json", "Machine-readable output")
		.action(async (action: string, opts: OptionValues) => {
			const { structureBaselineCommand } = await import("../commands/structure.js");
			await structureBaselineCommand(action, opts);
		});
}

function registerCoverageCommands(program: Command): void {
	// ===========================================
	// Coverage ratchet — per-file coverage-delta gate
	// ===========================================
	// NOTE: the parent description below is pinned verbatim by a single-line
	// assertion in quality.mutation-kill.test.ts, and GATE 2 of
	// `mutation_directed_assertion_removal` treats an edit to that line as a
	// removed assertion (the equivalence key includes the expected string), so
	// it cannot be reworded without the file-level suppression. The exit-policy
	// detail therefore lives on the `check` subcommand, which owns --strict.
	const coverageCmd = program
		.command("coverage")
		.description("Per-file coverage ratchet — fails on any file whose coverage drops");

	// Flag parity is a pinned contract (coverage-flag-parity.test.ts): every
	// option registered here must map to an `opts.<key>` that
	// `coverageCheckCommand` actually reads, and vice versa. The pre-2026-09
	// registration violated BOTH directions — `--summary`/`--baseline` were
	// accepted and silently ignored (the command reads `opts.report` and always
	// loads the baseline from the config dir), while `--strict` /
	// `--changed-files` / `--cwd` were read but unregistered, so commander
	// refused `--strict` as an unknown option and the ratchet could never fail.
	// `--report` deliberately carries NO default: an explicit path SUPPRESSES
	// the multi-report LCOV+istanbul merge in `resolveReportPaths`.
	coverageCmd
		.command("check", { isDefault: true })
		.description(
			"Compare current coverage against the baseline. Per-file drops are ADVISORY (exit 0) unless --strict is passed",
		)
		.option(
			"--report <path>",
			"Path to one coverage report (LCOV .info or istanbul JSON). Default: merge every discovered coverage report",
		)
		.option(
			"--changed-files <list>",
			"Comma-separated repo-relative paths; only report drops for these files",
		)
		.option("--update-baseline", "Persist the current coverage as the new baseline")
		.option("--strict", "exit non-zero on any per-file drop (default: advisory)")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { coverageCheckCommand } = await import("../commands/coverage.js");
			await coverageCheckCommand(opts);
		});

	coverageCmd
		.command("baseline")
		.description("Show the current coverage baseline")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			const { coverageBaselineCommand } = await import("../commands/coverage.js");
			coverageBaselineCommand(opts);
		});
}

function registerDeadcodeCommand(program: Command): void {
	// ===========================================
	// Deadcode — whole-repo reachability scan (the SCAN half of the two
	// dead-code controls; per-edit detection is `structural_checks.enabled`)
	// ===========================================
	program
		.command("deadcode")
		.description(
			"Scan the whole repo for dead-code candidates: unreachable files, unused import bindings, unused exports",
		)
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output (full, uncapped)")
		.option(
			"--categorize",
			"Bucket every candidate by deletion safety (future-scaffolding/deliberate-seam are keep; reexport-residue/orphaned-type/superseded are safe; + mutation-adjudicated inert branches)",
		)
		.action(async (opts: { json?: boolean; categorize?: boolean; cwd?: string }) => {
			const { deadcodeCommand } = await import("../commands/deadcode.js");
			process.exitCode = await deadcodeCommand(opts);
		});
}

function createMutationCommand(program: Command): Command {
	// ===========================================
	// Mutation ratchet — per-file mutation-score gate
	// ===========================================
	const mutationCmd = program
		.command("mutation")
		.description("Mutation testing: report-score ratchet, local runner measurement, and experimental durable cloud jobs");

	registerMutationCloudCommands(mutationCmd);
	return mutationCmd;
}

function registerMutationMeasurementCommands(mutationCmd: Command): void {
	mutationCmd
		.command("check", { isDefault: true })
		.description("Compare the Stryker report against baseline and exit non-zero on any drop")
		.option("--report <path>", "Path to Stryker mutation.json", "reports/mutation/mutation.json")
		.option(
			"--baseline <path>",
			"Path to baseline (defaults to .interlinked/mutation-baseline.json)",
		)
		.option("--update-baseline", "Persist the current mutation scores as the new baseline")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { mutationCheckCommand } = await import("../commands/mutation.js");
			await mutationCheckCommand(opts);
		});

	mutationCmd
		.command("baseline")
		.description("Show the current mutation-score baseline")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			const { mutationBaselineCommand } = await import("../commands/mutation.js");
			mutationBaselineCommand(opts);
		});

	mutationCmd
		.command("measure <file>")
		.description(
			"Measure one file with a local mutation runner. Read-only by default; --record persists only a complete, conclusive result as local manifest baseline state. Recording never certifies the file as clean.",
		)
		.option("--record", "Persist a complete, conclusive result as local manifest baseline state (never a clean certification)")
		.option("--runner-url <url>", "Override the configured runner endpoint(s)")
		.option("--budget-ms <ms>", "Total time to keep retrying busy/unreachable endpoints (default: 900000)")
		.option(
			"--skip-preflight",
			"Skip the local green-suite check. For repos where the local runner cannot run the scoped suite at all — NOT a way to measure past a known-failing suite, which scores every mutant it touches as killed",
		)
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (file: string, opts: OptionValues) => {
			const { mutationMeasureCommand } = await import("../commands/mutation.js");
			await mutationMeasureCommand(file, opts);
		});
}

function registerMutationWorklistCommands(mutationCmd: Command): void {
	mutationCmd
		.command("survivors")
		.description(
			"List the surviving mutants already recorded in .interlinked/mutation-manifest.json, ranked by open work. Reads state only — no runner, no re-measurement. --shard i/n deals the ranked file list round-robin so a fan-out across machines never overlaps or drops a file.",
		)
		.option("--file <substr>", "Only files whose path contains this (case-insensitive); switches to the per-mutant view")
		.option("--mutator <substr>", "Only mutants whose operator name contains this")
		.option("--top <n>", "Rows per table (default: 20)")
		.option("--shard <i/n>", "Report only the i-th of n slices of the ranked file list")
		.option("--include-dispositioned", "Also list survivors that already carry a disposition")
		.option("--include-stale", "Also list files that no longer exist in the working tree")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.action(async (opts: OptionValues) => {
			const { mutationSurvivorsCommand } = await import("../commands/mutation-survivors.js");
			await mutationSurvivorsCommand(opts);
		});

	mutationCmd
		.command("sweep")
		.description(
			"Re-measure local mutation targets and persist each complete, conclusive result as baseline state, never as a clean certification. Defaults to the ranked survivor work-list; --all-eligible performs a full source census. Repeat --runner-url to fan out across runner boxes.",
		)
		.option("--file <substr>", "Only files whose path contains this (case-insensitive)")
		.option("--limit <n>", "Measure at most n files (applied AFTER --shard)")
		.option("--shard <i/n>", "Sweep only the i-th of n slices of the ranked list")
		.option(
			"--all-eligible",
			"Census every mutation-eligible JS/TS source file under src/, including files absent from the manifest and measured-clean files",
		)
		.option(
			"--measured-before <iso>",
			"Only measure files with absent/legacy provenance or a measurement older than this ISO timestamp. Reuse one fixed cutoff to resume a census",
		)
		.option(
			"--unqualified-only",
			"Skip files whose records already carry measurement provenance. This is what makes a long sweep restartable: a finished file still has survivors, so without this a restart redoes the work",
		)
		.option("--dry-run", "Print the files this sweep would measure, and stop")
		.option(
			"--runner-url <url>",
			"Runner endpoint. Repeat the flag (or pass a comma-separated list) to fan out: each endpoint becomes one worker lane pulling from the shared file queue, which is the same shape a cloud fan-out has",
			(value: string, prior: string[] = []) => [...prior, value],
		)
		.option("--budget-ms <ms>", "Per-file time budget passed to the runner")
		.option(
			"--skip-preflight",
			"Skip the local green-suite check per file. NOT a way to sweep past a known-failing suite, which scores every mutant it touches as killed",
		)
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.action(async (opts: OptionValues) => {
			const { mutationSweepCommand } = await import("../commands/mutation-sweep.js");
			await mutationSweepCommand(opts);
		});
}

function registerMutationDispositionCommands(mutationCmd: Command): void {
	mutationCmd
		.command("accept")
		.description(
			"Explain why a surviving mutant cannot be accepted by prose. Since typed dispositions (plan 16 §7) status \"equivalent\" requires a verifier-issued certificate bound to the mutant's current symbol hash, which this command cannot mint — so it reports the refusal instead of writing one.",
		)
		.requiredOption("--file <path>", "Repo-relative path holding the mutant")
		.requiredOption("--id <mutantId>", "Mutant id from the gate's block message")
		.requiredOption("--reason <why>", "Why no test can kill this mutant (stored on the record)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { mutationAcceptCommand } = await import("../commands/mutation.js");
			await mutationAcceptCommand(opts);
		});

	mutationCmd
		.command("disposition")
		.description(
			"Record a NON-accepting judgment on a surviving mutant into the durable disposition ledger (.interlinked/mutation-dispositions.json), or --list / --show existing records. Kinds: dead_code (delete|implement) or unresolved (+ counterexample-search evidence). Never touches status, never grants equivalence, never suppresses the per-edit gate — an equivalence claim goes through `mutation accept`, which needs a verifier-issued certificate. Prose is refused by design.",
		)
		.option("--file <path>", "Repo-relative path holding the mutant (record / show)")
		.option("--id <mutantId>", "Mutant id from `mutation survivors` (record / show)")
		.option("--kind <kind>", "dead_code | unresolved")
		.option("--resolution <resolution>", "dead_code only: delete | implement")
		.option("--issue <ref>", "dead_code only: an issue/ticket reference")
		.option("--strategy <strategy>", "unresolved only: property | fuzz | differential | bounded_exhaustive | test_suite")
		.option("--runs <n>", "unresolved only: cases the search ran (required with --strategy)")
		.option("--seed <seed>", "unresolved only: the search seed")
		.option("--budget-ms <ms>", "unresolved only: the search time budget")
		.option("--list", "List every recorded disposition instead of recording")
		.option("--show", "Show the record for --file/--id instead of recording")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { mutationDispositionCommand } = await import("../commands/mutation-disposition.js");
			await mutationDispositionCommand(opts);
		});
}

function registerDesignCommand(program: Command): void {
	// ===========================================
	// Design — wrap Impeccable's deterministic design-slop detector
	// ===========================================
	program
		.command("design [path]")
		.description(
			"Run Impeccable's deterministic design-slop detector (overused fonts, accent stripes, gradient text, AI palettes, bounce easing, broken images, copy tells) on frontend files. Requires the optional `impeccable` CLI on PATH; degrades gracefully when absent. The built-in `design_slop` check covers a regex subset natively.",
		)
		.option("--gpt", "Also report GPT-specific provider tells")
		.option("--gemini", "Also report Gemini-specific provider tells")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed per-file output")
		.action(async (path: string | undefined, opts: OptionValues) => {
			const { designCommand } = await import("../commands/design.js");
			designCommand(path, opts);
		});
}

export function registerQualityCommands(program: Command): void {
	registerCheckAndSearchCommands(program);
	registerMultiEditCommand(program);
	registerVerifyCommand(program);
	registerWriteCommands(program);
	registerStructureCommands(program);
	registerCoverageCommands(program);
	registerDeadcodeCommand(program);
	registerMetricsCommands(program);
	const mutationCommand = createMutationCommand(program);
	registerMutationMeasurementCommands(mutationCommand);
	registerMutationWorklistCommands(mutationCommand);
	registerMutationDispositionCommands(mutationCommand);
	registerDesignCommand(program);
}
