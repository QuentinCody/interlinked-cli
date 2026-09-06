// ===========================================================================
// Mutation-kill companion for src/registrars/quality.ts.
//
// Every one of the 149 surviving mutants recorded against this file is a
// Stryker StringLiteral mutation (originalLexeme -> "") on a Commander
// `.description(...)` call or an `.option(flag, description[, default])`
// help-text argument. The existing quality.test.ts suite asserts command
// names, `--long` option flags, default values, and action-forwarding
// behavior — but never reads `.description()` on a Command or an Option, so
// none of the 149 help-text literals are observed anywhere. This file closes
// exactly that gap: for every top-level command and every subcommand, it
// asserts the command's own description AND the full {flag: description}
// map of every option in one shot, so any single description string emptied
// anywhere in the file produces a visible mismatch.
//
// No mocking is needed: `registerQualityCommands` builds the whole Command
// tree synchronously and none of these assertions ever invoke `.action(...)`
// callbacks (which is where the lazily-imported command modules are used).
// ===========================================================================

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerQualityCommands } from "./quality.js";

function build(): Command {
	const program = new Command();
	registerQualityCommands(program);
	return program;
}

function top(program: Command, name: string): Command {
	return nonNull(
		program.commands.find((c) => c.name() === name),
		`missing top-level command: ${name}`,
	);
}

function child(parent: Command, name: string): Command {
	return nonNull(
		parent.commands.find((c) => c.name() === name),
		`missing subcommand: ${name} under ${parent.name()}`,
	);
}

/** Every option's `--long` flag mapped to its full description text. */
function optionDescriptions(cmd: Command): Record<string, string> {
	const out: Record<string, string> = {};
	for (const o of cmd.options) {
		out[nonNull(o.long, `option with no --long flag on ${cmd.name()}`)] = o.description;
	}
	return out;
}

describe("registerQualityCommands — command + option descriptions (mutation-kill)", () => {
	// test-contract: public-api — check exposes its documented command and option help text
	it("check", () => {
		const cmd = top(build(), "check");
		expect(cmd.description()).toBe(
			"Scan project for structural issues and optionally run external tool checks (tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, etc.)",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--only":
				"Run only a specific check (structural: broken-imports, cycles, duplicates, missing-tests, secrets, any-types, blast-radius, dead-imports; tools: tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, cargo-check, cargo-clippy, go-build, golangci-lint, c-compile, clang-tidy)",
			"--tools": "Also run external tool checks (comma-separated, or omit for all available)",
			"--report": "Show tool coverage/discovery report",
			"--json": "Machine-readable output",
			"--cwd": "Project root (default: current directory)",
		});
	});

	// test-contract: public-api — search exposes its documented command and option help text
	it("search", () => {
		const cmd = top(build(), "search");
		expect(cmd.description()).toBe("Search the local codebase (ripgrep with native fallback)");
		expect(optionDescriptions(cmd)).toEqual({
			"--path": "Search root directory (default: cwd)",
			"--glob": "File glob pattern (e.g. '*.ts')",
			"--type": "File type filter for ripgrep (e.g. ts, py, rust)",
			"--limit": "Max results (default: 30, max: 200)",
			"--context": "Context lines around matches (default: 2)",
			"--engine": "Force engine: ripgrep or native",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
			"--full": "Full output with context lines",
		});
	});

	// test-contract: public-api — multi-edit exposes its documented command and option help text
	it("multi-edit", () => {
		const cmd = top(build(), "multi-edit");
		expect(cmd.description()).toBe(
			"Apply N old/new string edits atomically to one or more files. Gate runs once on final content. Ambiguity evaluated after prior edits.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--stdin":
				"Read a manifest from stdin: {version,batches} for multi-file (no <path> needed), or {version,edits} with <path> for one file. PREFERRED — no temp file.",
			"--manifest":
				"Read the same manifest shapes from <file>. Only for a manifest you already have on disk; prefer --stdin.",
			"--json": "Machine-readable output (emits the design-doc error-code shape)",
		});
	});

	// test-contract: public-api — verify exposes its documented command and option help text
	it("verify", () => {
		const cmd = top(build(), "verify");
		expect(cmd.description()).toBe(
			"Run the default high-signal external catalog plus diff-safe inline checks. Target can be a local path, GitHub URL, or any git remote URL.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--only":
				"Run one named external check (for example: tsc, biome, oxlint, eslint, semgrep, gitleaks, knip, docs-check, sca)",
			"--suggestions": "Also run scored regex heuristics (sql-injection, perf, quality)",
			"--json": "Machine-readable output",
			"--details": "Show per-file details for all findings",
			"--cwd": "Project root (default: current directory)",
			"--branch": "Branch, tag, or commit to check (remote repos)",
			"--subdir": "Only scan a subdirectory (useful for monorepos)",
			"--skip": "Skip specific checks (comma-separated: semgrep,knip,complexity,silent_catches,...)",
			"--suppress": "Suppress a finding: file:check or file:check:reason",
			"--show-suppressions": "List all active suppressions",
			"--structure": "Include generic artifact structure checks",
			"--structure-only": "Run only structure checks",
			"--adoption-gate": "Fail when adopted categories drop below thresholds",
			"--all-checks":
				"Include broad advisory smell checks and dead-code scans in addition to the default high-signal audit",
			"--dead-code":
				"Run Supermodel's cloud dead-code analysis (opt-in; requires the `supermodel` CLI)",
		});
	});

	// test-contract: public-api — the write command advertises rollback protection without claiming impossible multi-file atomicity
	it("write", () => {
		const cmd = top(build(), "write");
		expect(cmd.description()).toBe(
			"Write file(s) through the content-quality gate (pre_block + biome + tsc diff-overlay). Supports --stdin, --from-file, and --batch <manifest.json> with rollback protection.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--stdin": "Read content from stdin (single-file mode)",
			"--from-file": "Read content from a source file (single-file mode)",
			"--batch": "Path to a batch manifest JSON {version:1, writes:[{path,content}]}",
			"--unsafe-outside-repo": "Allow writing outside the project root (discouraged)",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — verify-changeset exposes its documented command and option help text
	it("verify-changeset", () => {
		const cmd = top(build(), "verify-changeset");
		expect(cmd.description()).toBe(
			"Preview the content-quality gate (pre_block + biome + tsc diff-overlay) over a PROPOSED changeset WITHOUT writing — the agent-callable self-gate. Input JSON {version:1, changes:[{path,content}|{path,old_string,new_string}|{path,edits}]} via --file or --stdin.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--file": "Path to a changeset JSON file",
			"--stdin": "Read the changeset JSON from stdin",
			"--warnings": "Also surface pre_warn advisories (default: match the enforced gate)",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — structure parent exposes its documented command help text
	it("structure (parent — no own options)", () => {
		const cmd = top(build(), "structure");
		expect(cmd.description()).toBe("Generic artifact structure management (manifests, catalogs, adoption)");
		expect(optionDescriptions(cmd)).toEqual({});
	});

	// test-contract: public-api — structure init exposes its documented command and option help text
	it("structure > init", () => {
		const cmd = child(top(build(), "structure"), "init");
		expect(cmd.description()).toBe("Create interlinked/structure.json and scaffold artifact files");
		expect(optionDescriptions(cmd)).toEqual({
			"--mode": "Structure mode: minimal, standard, strict",
			"--with": "Comma-separated artifact categories to scaffold",
			"--write": "Actually write files (default is dry-run)",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — structure scan exposes its documented command and option help text
	it("structure > scan", () => {
		const cmd = child(top(build(), "structure"), "scan");
		expect(cmd.description()).toBe("Build or refresh local generated artifact catalogs");
		expect(optionDescriptions(cmd)).toEqual({
			"--full": "Force full rescan",
			"--incremental": "Only refresh changed categories",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — structure status exposes its documented command and option help text
	it("structure > status", () => {
		const cmd = child(top(build(), "structure"), "status");
		expect(cmd.description()).toBe("Show adoption coverage, cache staleness, and invalid references");
		expect(optionDescriptions(cmd)).toEqual({ "--json": "Machine-readable output" });
	});

	// test-contract: public-api — structure accept exposes its documented command and option help text
	it("structure > accept", () => {
		const cmd = child(top(build(), "structure"), "accept");
		expect(cmd.description()).toBe("Promote extracted findings into committed artifact files");
		expect(optionDescriptions(cmd)).toEqual({ "--json": "Machine-readable output" });
	});

	// test-contract: public-api — structure doctor exposes its documented command and option help text
	it("structure > doctor", () => {
		const cmd = child(top(build(), "structure"), "doctor");
		expect(cmd.description()).toBe("Validate structure files, cache freshness, and cross-references");
		expect(optionDescriptions(cmd)).toEqual({ "--json": "Machine-readable output" });
	});

	// test-contract: public-api — structure baseline exposes its documented command and option help text
	it("structure > baseline", () => {
		const cmd = child(top(build(), "structure"), "baseline");
		expect(cmd.description()).toBe("Manage structure baselines (save, clear, status)");
		expect(optionDescriptions(cmd)).toEqual({ "--json": "Machine-readable output" });
	});

	// test-contract: public-api — coverage parent exposes its documented command help text
	it("coverage (parent — no own options)", () => {
		const cmd = top(build(), "coverage");
		expect(cmd.description()).toBe("Per-file coverage ratchet — fails on any file whose coverage drops");
		expect(optionDescriptions(cmd)).toEqual({});
	});

	// test-contract: public-api — coverage check exposes its documented command and option help text
	it("coverage > check", () => {
		const cmd = child(top(build(), "coverage"), "check");
		expect(cmd.description()).toBe(
			"Compare current coverage against the baseline. Per-file drops are ADVISORY (exit 0) unless --strict is passed",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--report":
				"Path to one coverage report (LCOV .info or istanbul JSON). Default: merge every discovered coverage report",
			"--changed-files": "Comma-separated repo-relative paths; only report drops for these files",
			"--update-baseline": "Persist the current coverage as the new baseline",
			"--strict": "exit non-zero on any per-file drop (default: advisory)",
			"--cwd": "Project root (default: current directory)",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — coverage baseline exposes its documented command and option help text
	it("coverage > baseline", () => {
		const cmd = child(top(build(), "coverage"), "baseline");
		expect(cmd.description()).toBe("Show the current coverage baseline");
		expect(optionDescriptions(cmd)).toEqual({ "--json": "Machine-readable output" });
	});

	// test-contract: public-api — metrics parent exposes its documented command and option help text
	it("metrics (parent — has its own options)", () => {
		const cmd = top(build(), "metrics");
		expect(cmd.description()).toBe(
			"Scan the whole codebase: function tokens, companion-test presence, coverage, complexity, and CRAP",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--cwd": "Project root (default: current directory)",
			"--top": "Number of function/file token and CRAP hotspots to show (default: 25)",
			"--include-tests": "Include test/spec functions as advisory token measurements",
			"--json": "Machine-readable output (full per-file + per-function)",
			"--short": "One-line summary",
			"--full": "Show every per-file and per-function token measurement",
		});
	});

	// test-contract: public-api — metrics coupling exposes its documented command and option help text
	it("metrics > coupling", () => {
		const cmd = child(top(build(), "metrics"), "coupling");
		expect(cmd.description()).toBe(
			"Change coupling from git history — co-changed file pairs; pairs with no import edge are flagged 'hidden'",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--cwd": "Project root (default: current directory)",
			"--since": "git --since expression (default: '90 days ago')",
			"--min-support": "Minimum co-change commits per pair (default: 4)",
			"--max-commit-files": "Skip bulk commits touching more files (default: 30)",
			"--min-strength": "Minimum Tornhill strength percentage (default: 30)",
			"--limit": "Maximum pairs to report (default: 25)",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
	});

	// test-contract: public-api — metrics arch exposes its documented command and option help text
	it("metrics > arch", () => {
		const cmd = child(top(build(), "metrics"), "arch");
		expect(cmd.description()).toBe(
			"Martin metrics per directory (Ca/Ce/instability) + propagation cost from the import graph",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--cwd": "Project root (default: current directory)",
			"--depth": "Directory fold depth (default: 2)",
			"--include-tests": "Include test files in the edge set",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
	});

	// test-contract: public-api — metrics rework exposes its documented command and option help text
	it("metrics > rework", () => {
		const cmd = child(top(build(), "metrics"), "rework");
		expect(cmd.description()).toBe(
			"Churn age from git blame — share of changed lines whose previous version was written in the last --window days",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--cwd": "Project root (default: current directory)",
			"--days": "How far back to scan commits (default: 30)",
			"--window": "Rework age threshold in days (default: 14)",
			"--max-commits": "Commit scan cap (default: 100)",
			"--max-commit-files": "Skip bulk commits touching more files (default: 30)",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
	});

	// test-contract: public-api — mutation parent exposes its documented command help text
	it("mutation (parent — no own options)", () => {
		const cmd = top(build(), "mutation");
		expect(cmd.description()).toBe(
			"Mutation testing: report-score ratchet, local runner measurement, and experimental durable cloud jobs",
		);
		expect(optionDescriptions(cmd)).toEqual({});
	});

	// test-contract: public-api — mutation check exposes its documented command and option help text
	it("mutation > check", () => {
		const cmd = child(top(build(), "mutation"), "check");
		expect(cmd.description()).toBe("Compare the Stryker report against baseline and exit non-zero on any drop");
		expect(optionDescriptions(cmd)).toEqual({
			"--report": "Path to Stryker mutation.json",
			"--baseline": "Path to baseline (defaults to .interlinked/mutation-baseline.json)",
			"--update-baseline": "Persist the current mutation scores as the new baseline",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — mutation baseline exposes its documented command and option help text
	it("mutation > baseline", () => {
		const cmd = child(top(build(), "mutation"), "baseline");
		expect(cmd.description()).toBe("Show the current mutation-score baseline");
		expect(optionDescriptions(cmd)).toEqual({ "--json": "Machine-readable output" });
	});

	// test-contract: public-api — mutation measure exposes its documented command and option help text
	it("mutation > measure", () => {
		const cmd = child(top(build(), "mutation"), "measure");
		expect(cmd.description()).toBe(
			"Measure one file with a local mutation runner. Read-only by default; --record persists only a complete, conclusive result as local manifest baseline state. Recording never certifies the file as clean.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--record":
				"Persist a complete, conclusive result as local manifest baseline state (never a clean certification)",
			"--runner-url": "Override the configured runner endpoint(s)",
			"--budget-ms": "Total time to keep retrying busy/unreachable endpoints (default: 900000)",
			"--skip-preflight":
				"Skip the local green-suite check. For repos where the local runner cannot run the scoped suite at all — NOT a way to measure past a known-failing suite, which scores every mutant it touches as killed",
			"--cwd": "Project root (default: current directory)",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — mutation survivors exposes its documented command and option help text
	it("mutation > survivors", () => {
		const cmd = child(top(build(), "mutation"), "survivors");
		expect(cmd.description()).toBe(
			"List the surviving mutants already recorded in .interlinked/mutation-manifest.json, ranked by open work. Reads state only — no runner, no re-measurement. --shard i/n deals the ranked file list round-robin so a fan-out across machines never overlaps or drops a file.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--file": "Only files whose path contains this (case-insensitive); switches to the per-mutant view",
			"--mutator": "Only mutants whose operator name contains this",
			"--top": "Rows per table (default: 20)",
			"--shard": "Report only the i-th of n slices of the ranked file list",
			"--include-dispositioned": "Also list survivors that already carry a disposition",
			"--include-stale": "Also list files that no longer exist in the working tree",
			"--cwd": "Project root (default: current directory)",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
	});

	// test-contract: public-api — mutation sweep exposes its documented command and option help text
	it("mutation > sweep", () => {
		const cmd = child(top(build(), "mutation"), "sweep");
		expect(cmd.description()).toBe(
			"Re-measure local mutation targets and persist each complete, conclusive result as baseline state, never as a clean certification. Defaults to the ranked survivor work-list; --all-eligible performs a full source census. Repeat --runner-url to fan out across runner boxes.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--file": "Only files whose path contains this (case-insensitive)",
			"--limit": "Measure at most n files (applied AFTER --shard)",
			"--shard": "Sweep only the i-th of n slices of the ranked list",
			"--all-eligible":
				"Census every mutation-eligible JS/TS source file under src/, including files absent from the manifest and measured-clean files",
			"--measured-before":
				"Only measure files with absent/legacy provenance or a measurement older than this ISO timestamp. Reuse one fixed cutoff to resume a census",
			"--unqualified-only":
				"Skip files whose records already carry measurement provenance. This is what makes a long sweep restartable: a finished file still has survivors, so without this a restart redoes the work",
			"--dry-run": "Print the files this sweep would measure, and stop",
			"--runner-url":
				"Runner endpoint. Repeat the flag (or pass a comma-separated list) to fan out: each endpoint becomes one worker lane pulling from the shared file queue, which is the same shape a cloud fan-out has",
			"--budget-ms": "Per-file time budget passed to the runner",
			"--skip-preflight":
				"Skip the local green-suite check per file. NOT a way to sweep past a known-failing suite, which scores every mutant it touches as killed",
			"--cwd": "Project root (default: current directory)",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
	});

	// test-contract: public-api — mutation accept exposes its documented command and option help text
	it("mutation > accept", () => {
		const cmd = child(top(build(), "mutation"), "accept");
		expect(cmd.description()).toBe(
			"Explain why a surviving mutant cannot be accepted by prose. Since typed dispositions (plan 16 §7) status \"equivalent\" requires a verifier-issued certificate bound to the mutant's current symbol hash, which this command cannot mint — so it reports the refusal instead of writing one.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--file": "Repo-relative path holding the mutant",
			"--id": "Mutant id from the gate's block message",
			"--reason": "Why no test can kill this mutant (stored on the record)",
			"--json": "Machine-readable output",
		});
	});

	// test-contract: public-api — design exposes its documented command and option help text
	it("design", () => {
		const cmd = top(build(), "design");
		expect(cmd.description()).toBe(
			"Run Impeccable's deterministic design-slop detector (overused fonts, accent stripes, gradient text, AI palettes, bounce easing, broken images, copy tells) on frontend files. Requires the optional `impeccable` CLI on PATH; degrades gracefully when absent. The built-in `design_slop` check covers a regex subset natively.",
		);
		expect(optionDescriptions(cmd)).toEqual({
			"--gpt": "Also report GPT-specific provider tells",
			"--gemini": "Also report Gemini-specific provider tells",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
			"--full": "Detailed per-file output",
		});
	});

	// test-contract: boundary — unknown command names are rejected with stable lookup errors
	// Negative-path case (failure_triage's happy-path-only heuristic wants at
	// least one): both lookup helpers throw for a name that was never
	// registered, instead of silently returning undefined into the caller.
	it("top()/child() throw for a command name that was never registered", () => {
		const program = build();
		expect(() => top(program, "does-not-exist")).toThrow(/missing top-level command/);
		expect(() => child(top(program, "structure"), "does-not-exist")).toThrow(/missing subcommand/);
	});
});
