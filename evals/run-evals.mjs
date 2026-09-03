#!/usr/bin/env node
// harness-compat evals driver — real-agent behavioral evals proving the
// harness still PERMITS normal agent work (the regression class vitest can't
// catch). Plain node, no npm deps. Docs: evals/README.md.
// Preview the plan without running anything:  node evals/run-evals.mjs --dry-run
//
// Layout: this file = planning/orchestration; evals/lib/fixture-ops.mjs = disk
// + process operations; evals/lib/scorecard.mjs = table rendering;
// src/harness/eval-metrics.ts = pure metric math (vitest-covered).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	binaryAvailable,
	cleanupFixture,
	enableHarness,
	evaluateSuccess,
	FIXTURES_DIR,
	harvestRulesStats,
	loadMetricsModule,
	parseJsonFile,
	readActivityLines,
	run,
	setupFixture,
	stopHarness,
	TASKS_DIR,
	timedOut,
} from "./lib/fixture-ops.mjs";
import { renderCells, renderComparisonRows, renderPlan, renderVerdicts } from "./lib/scorecard.mjs";

const MAX_AGENT_TURNS = "30";
const REPO_SHAPES = new Set(["colocated-tdd", "separate-tests", "no-tests", "python"]);
const CHECK_TYPES = new Set(["file_exists", "file_contains", "command_exits_zero"]);
const GROUP_SEP = "\\u0000"; // NUL escape — cannot appear in a task slug or runner name

const RUNNERS = {
	claude: {
		name: "claude",
		bin: "claude",
		clientId: "claude",
		buildCommand(prompt) {
			return [
				"claude",
				["-p", prompt, "--model", "haiku", "--dangerously-skip-permissions", "--max-turns", MAX_AGENT_TURNS],
			];
		},
	},
	codex: {
		name: "codex",
		bin: "codex",
		clientId: "codex",
		buildCommand(prompt) {
			const model = process.env.EVALS_CODEX_MODEL || "gpt-5.1-codex-mini";
			return ["codex", ["exec", "--model", model, "--skip-git-repo-check", "--sandbox", "workspace-write", prompt]];
		},
	},
};

function usage() {
	process.stdout.write(`harness-compat evals driver

usage: node evals/run-evals.mjs [flags]

flags:
  --tasks a,b     run only these task slugs (default: all under evals/tasks/)
  --arms on,off   arms to run, executed in the order given (default: on,off)
  --runners claude,codex
                  agent CLIs to drive; absent binaries are skipped (default: claude,codex)
  --repeat N      repetitions per (task, runner, arm); use 2+ to confirm FAILs (default: 1)
  --dry-run       print the plan and the exact commands, execute nothing
  --json          emit the full result JSON instead of tables
  --keep          keep tmp fixture dirs for post-mortem (prints their paths)
  -h, --help      this text

environment:
  EVALS_CODEX_MODEL  codex model id for the codex runner (default: gpt-5.1-codex-mini)
  EVALS_TMPDIR       base dir for throwaway fixture copies (default: os tmpdir)
`);
}

function parseList(value) {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function parseRepeat(raw) {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) throw new Error("--repeat needs a positive integer");
	return n;
}

function applyFlag(opts, flag, readValue) {
	if (flag === "--tasks") opts.tasks = parseList(readValue());
	else if (flag === "--arms") opts.arms = parseList(readValue());
	else if (flag === "--runners") opts.runners = parseList(readValue());
	else if (flag === "--repeat") opts.repeat = parseRepeat(readValue());
	else if (flag === "--dry-run") opts.dryRun = true;
	else if (flag === "--json") opts.json = true;
	else if (flag === "--keep") opts.keep = true;
	else if (flag === "--help" || flag === "-h") opts.help = true;
	else throw new Error(`unknown flag: ${flag} (see --help)`);
}

function validateOpts(opts) {
	for (const arm of opts.arms) {
		if (arm !== "on" && arm !== "off") throw new Error(`invalid arm "${arm}" (use on/off)`);
	}
	for (const runner of opts.runners) {
		if (!RUNNERS[runner]) throw new Error(`unknown runner "${runner}" (have: ${Object.keys(RUNNERS).join(", ")})`);
	}
}

function parseArgs(argv) {
	const opts = {
		tasks: null,
		arms: ["on", "off"],
		runners: ["claude", "codex"],
		repeat: 1,
		dryRun: false,
		json: false,
		keep: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const next = () => {
			i += 1;
			if (i >= argv.length) throw new Error(`${flag} needs a value`);
			return argv[i];
		};
		applyFlag(opts, flag, next);
	}
	validateOpts(opts);
	return opts;
}

function validateTask(task, slug, manifestPath) {
	if (task.slug !== slug) throw new Error(`${manifestPath}: slug "${task.slug}" != directory name "${slug}"`);
	if (typeof task.prompt !== "string" || task.prompt.length === 0) throw new Error(`${manifestPath}: prompt required`);
	if (!REPO_SHAPES.has(task.repo_shape)) throw new Error(`${manifestPath}: unknown repo_shape "${task.repo_shape}"`);
	if (!fs.existsSync(path.join(FIXTURES_DIR, task.repo_shape))) {
		throw new Error(`${manifestPath}: fixture template missing for shape "${task.repo_shape}"`);
	}
	if (typeof task.success_check !== "object" || task.success_check === null || !CHECK_TYPES.has(task.success_check.type)) {
		throw new Error(`${manifestPath}: success_check.type must be one of ${[...CHECK_TYPES].join(", ")}`);
	}
	if (!Number.isInteger(task.timeout_s) || task.timeout_s < 30) {
		throw new Error(`${manifestPath}: timeout_s must be an integer >= 30`);
	}
}

function loadTasks(filter) {
	const slugs = fs
		.readdirSync(TASKS_DIR)
		.filter((entry) => fs.existsSync(path.join(TASKS_DIR, entry, "task.json")))
		.sort();
	const tasks = slugs.map((slug) => {
		const manifestPath = path.join(TASKS_DIR, slug, "task.json");
		const task = parseJsonFile(manifestPath);
		validateTask(task, slug, manifestPath);
		return task;
	});
	if (filter === null) return tasks;
	const known = new Set(tasks.map((t) => t.slug));
	for (const want of filter) {
		if (!known.has(want)) throw new Error(`--tasks: unknown task "${want}" (have: ${[...known].join(", ")})`);
	}
	return tasks.filter((t) => filter.includes(t.slug));
}

function detectAvailability(opts) {
	const runners = [];
	const skipped = [];
	for (const name of opts.runners) {
		if (binaryAvailable(RUNNERS[name].bin)) runners.push(name);
		else skipped.push(`${name} (binary "${RUNNERS[name].bin}" not on PATH)`);
	}
	return { runners, skipped, interlinked: binaryAvailable("interlinked") };
}

function buildPlan(tasks, opts, availability) {
	const plan = [];
	for (const task of tasks) {
		for (const runner of availability.runners) {
			for (let rep = 1; rep <= opts.repeat; rep += 1) {
				for (const arm of opts.arms) plan.push({ task, runner, arm, rep });
			}
		}
	}
	return plan;
}

function round3(n) {
	return Math.round(n * 1000) / 1000;
}

function harvestCellMetrics(metricsModule, cell, dir) {
	const lines = readActivityLines(dir);
	cell.activity_events = lines.filter((line) => line.trim() !== "").length;
	cell.metrics = metricsModule.extractEvalMetrics(lines);
	cell.noise_ratio = round3(metricsModule.noiseRatio(cell.metrics));
	cell.rules_stats = harvestRulesStats(dir);
}

function runCell(metricsModule, planItem, opts) {
	const { task, arm, rep } = planItem;
	const runner = RUNNERS[planItem.runner];
	const startedAt = Date.now();
	const cell = {
		task: task.slug,
		runner: runner.name,
		arm,
		rep,
		success: false,
		seconds: 0,
		timed_out: false,
		agent_exit: null,
		setup_error: null,
		activity_events: 0,
		metrics: null,
		noise_ratio: 0,
		rules_stats: null,
		dir: null,
	};
	let dir = null;
	try {
		dir = setupFixture(task, `${runner.name}-${arm}${rep}`);
		if (arm === "on") enableHarness(dir, runner.clientId);
		const [bin, args] = runner.buildCommand(task.prompt);
		const result = run(bin, args, dir, task.timeout_s);
		cell.agent_exit = result.status;
		cell.timed_out = timedOut(result);
		cell.success = evaluateSuccess(task.success_check, dir);
		harvestCellMetrics(metricsModule, cell, dir);
	} catch (err) {
		cell.setup_error = String((err && err.message) || err).slice(0, 300);
	} finally {
		if (dir !== null) {
			if (arm === "on") stopHarness(dir);
			if (opts.keep) {
				cell.dir = dir;
				process.stderr.write(`kept fixture: ${dir}\n`);
			} else {
				cleanupFixture(dir);
			}
		}
		cell.seconds = Math.round((Date.now() - startedAt) / 100) / 10;
	}
	return cell;
}

function groupKeys(cells) {
	return [...new Set(cells.map((cell) => `${cell.task}${GROUP_SEP}${cell.runner}`))].sort();
}

function buildVerdicts(metricsModule, cells) {
	const verdicts = [];
	for (const key of groupKeys(cells)) {
		const [task, runner] = key.split(GROUP_SEP);
		const group = cells
			.filter((cell) => cell.task === task && cell.runner === runner && cell.setup_error === null)
			.map((cell) => ({ arm: cell.arm, rep: cell.rep, success: cell.success, metrics: cell.metrics }));
		verdicts.push({ task, runner, ...metricsModule.taskVerdict(group) });
	}
	return verdicts;
}

function buildComparisons(metricsModule, cells) {
	const comparisons = [];
	for (const key of groupKeys(cells)) {
		const [task, runner] = key.split(GROUP_SEP);
		const group = cells.filter((cell) => cell.task === task && cell.runner === runner && cell.setup_error === null);
		const on = group.filter((cell) => cell.arm === "on");
		const off = group.filter((cell) => cell.arm === "off");
		if (on.length === 0 || off.length === 0) continue;
		const rows = metricsModule.compareArms(
			metricsModule.aggregateMetrics(on.map((cell) => cell.metrics)),
			metricsModule.aggregateMetrics(off.map((cell) => cell.metrics)),
			on.some((cell) => cell.success),
			off.some((cell) => cell.success),
		);
		comparisons.push({ task, runner, rows });
	}
	return comparisons;
}

function shellPreview(arg) {
	return /[\s"<>|&]/.test(arg) ? JSON.stringify(arg) : arg;
}

function printDryRun(plan, opts, availability) {
	process.stdout.write("harness-compat evals — DRY RUN (nothing executed)\n\n");
	if (availability.skipped.length > 0) process.stdout.write(`skipped runners: ${availability.skipped.join("; ")}\n`);
	const interlinkedNote = availability.interlinked ? "yes" : "NO — harness-on cells would fail fast";
	process.stdout.write(`interlinked on PATH: ${interlinkedNote}\n`);
	process.stdout.write(`repeat: ${opts.repeat} — total cells: ${plan.length}\n\n`);
	if (plan.length > 0) process.stdout.write(`${renderPlan(plan)}\n\n`);
	for (const name of new Set(plan.map((item) => item.runner))) {
		const [bin, args] = RUNNERS[name].buildCommand("<task prompt>");
		process.stdout.write(`${name} command: ${bin} ${args.map(shellPreview).join(" ")}\n`);
	}
	process.stdout.write(
		"\nper harness-on cell: interlinked enable --clients <runner> --sync-mode local && interlinked harness start (in the fixture copy)\n",
	);
	process.stdout.write("run for real by dropping --dry-run\n");
}

function printScorecard(cells, comparisons, verdicts, availability) {
	process.stdout.write("\n=== harness-compat evals — scorecard ===\n\n");
	process.stdout.write(`${renderCells(cells)}\n\n`);
	for (const comparison of comparisons) {
		process.stdout.write(`--- ${comparison.task} / ${comparison.runner} (on vs off, reps aggregated) ---\n`);
		process.stdout.write(`${renderComparisonRows(comparison.rows)}\n\n`);
	}
	process.stdout.write("=== verdicts ===\n");
	process.stdout.write(`${renderVerdicts(verdicts)}\n`);
	if (availability.skipped.length > 0) process.stdout.write(`\nskipped runners: ${availability.skipped.join("; ")}\n`);
}

function warnOnGlobalHooks(opts) {
	if (!opts.arms.includes("off")) return;
	const globalSettings = path.join(os.homedir(), ".claude", "settings.json");
	try {
		if (fs.existsSync(globalSettings) && fs.readFileSync(globalSettings, "utf8").includes("interlinked")) {
			process.stderr.write(
				"warn: ~/.claude/settings.json references interlinked hooks — the harness-off arm may not be a clean control\n",
			);
		}
	} catch (err) {
		process.stderr.write(`warn: could not inspect ${globalSettings}: ${err.message}\n`);
	}
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${err.message}\n\n`);
		usage();
		return 2;
	}
	if (opts.help) {
		usage();
		return 0;
	}
	const tasks = loadTasks(opts.tasks);
	const availability = detectAvailability(opts);
	warnOnGlobalHooks(opts);
	if (opts.arms.includes("on") && !availability.interlinked && !opts.dryRun) {
		throw new Error('harness-on arm requested but "interlinked" is not on PATH');
	}
	const plan = buildPlan(tasks, opts, availability);
	if (opts.dryRun) {
		printDryRun(plan, opts, availability);
		return 0;
	}
	if (plan.length === 0) {
		process.stderr.write("empty plan — no requested runner is available on PATH\n");
		return 2;
	}
	const metricsModule = await loadMetricsModule();
	const cells = [];
	for (const [index, item] of plan.entries()) {
		process.stderr.write(
			`[${index + 1}/${plan.length}] ${item.task.slug} / ${item.runner} / ${item.arm} / rep ${item.rep}\n`,
		);
		cells.push(runCell(metricsModule, item, opts));
	}
	const verdicts = buildVerdicts(metricsModule, cells);
	const comparisons = buildComparisons(metricsModule, cells);
	if (opts.json) {
		const report = {
			generated_at: new Date().toISOString(),
			options: opts,
			skipped_runners: availability.skipped,
			cells,
			comparisons,
			verdicts,
		};
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		printScorecard(cells, comparisons, verdicts, availability);
	}
	return verdicts.some((v) => v.verdict === "FAIL") ? 1 : 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		process.stderr.write(`fatal: ${err.message}\n`);
		process.exitCode = 2;
	});
