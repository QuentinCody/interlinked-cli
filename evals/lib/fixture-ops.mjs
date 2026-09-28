// Fixture + process operations for the harness-compat eval driver.
// Plain node, no npm deps. Everything that touches disk or spawns a process
// lives here; evals/run-evals.mjs holds planning/orchestration, and all
// metric math lives in src/harness/eval-metrics.ts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EVALS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(EVALS_DIR);
export const FIXTURES_DIR = path.join(EVALS_DIR, "fixtures");
export const TASKS_DIR = path.join(EVALS_DIR, "tasks");

const SETUP_TIMEOUT_S = 120;
const STOP_TIMEOUT_S = 60;
const DEFAULT_CHECK_TIMEOUT_S = 180;

export function agentEnv() {
	const env = { ...process.env, INTERLINKED_SYNC_MODE: "local" };
	// A nested headless agent must not inherit this session's Claude Code markers.
	delete env.CLAUDECODE;
	delete env.CLAUDE_CODE_ENTRYPOINT;
	delete env.CLAUDE_CODE_SSE_PORT;
	return env;
}

export function run(command, args, cwd, timeoutS, options = {}) {
	return spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...agentEnv(), ...options.env },
		timeout: timeoutS * 1000,
		killSignal: "SIGKILL",
		maxBuffer: 64 * 1024 * 1024,
	});
}

export function timedOut(result) {
	return Boolean(result.error && result.error.code === "ETIMEDOUT") || result.signal === "SIGKILL";
}

export function outputTail(result) {
	const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
	return text.split("\n").slice(-3).join(" | ").slice(0, 300);
}

export function binaryAvailable(bin) {
	return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
}

export function parseJsonFile(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (err) {
		throw new Error(`${filePath}: unreadable JSON (${err.message})`);
	}
}

function tmpBase() {
	// macOS's long per-user temp path can exceed the Unix socket path limit.
	const base = process.env.EVALS_TMPDIR || (process.platform === "darwin" ? "/tmp" : os.tmpdir());
	fs.mkdirSync(base, { recursive: true });
	return base;
}

function linkNodeModules(dir) {
	const pkgPath = path.join(dir, "package.json");
	if (!fs.existsSync(pkgPath)) return;
	const pkg = parseJsonFile(pkgPath);
	const testScript = pkg.scripts ? pkg.scripts.test : undefined;
	if (typeof testScript !== "string" || !testScript.includes("vitest")) return;
	const source = path.join(REPO_ROOT, "node_modules");
	if (!fs.existsSync(source)) {
		throw new Error("repo node_modules missing — run npm install in interlinked-cli first (fixtures borrow its vitest)");
	}
	fs.symlinkSync(source, path.join(dir, "node_modules"), "dir");
}

export function setupFixture(task, label) {
	const dir = fs.mkdtempSync(path.join(tmpBase(), `hce-${task.slug}-${label}-`));
	fs.cpSync(path.join(FIXTURES_DIR, task.repo_shape), dir, { recursive: true });
	linkNodeModules(dir);
	return dir;
}

export function cleanupFixture(dir) {
	if (!path.basename(dir).startsWith("hce-")) return; // only delete dirs this driver created
	fs.rmSync(dir, { recursive: true, force: true });
}

export function harnessCommand(artifact, args, cwd, timeoutS) {
	return artifact ? run(process.execPath, [artifact, ...args], cwd, timeoutS) : run("interlinked", args, cwd, timeoutS);
}

export function enableHarness(dir, clientId, artifact) {
	const enable = harnessCommand(artifact, ["enable", "--clients", clientId, "--sync-mode", "local"], dir, SETUP_TIMEOUT_S);
	if (enable.status !== 0) {
		throw new Error(`interlinked enable failed (exit ${enable.status}): ${outputTail(enable)}`);
	}
	const start = harnessCommand(artifact, ["harness", "start"], dir, SETUP_TIMEOUT_S);
	if (start.status !== 0) {
		throw new Error(`interlinked harness start failed (exit ${start.status}): ${outputTail(start)}`);
	}
}

export function stopHarness(dir, artifact) {
	const result = harnessCommand(artifact, ["harness", "stop"], dir, STOP_TIMEOUT_S);
	if (result.status !== 0) process.stderr.write(`warn: "interlinked harness stop" in ${dir} exited ${result.status}\n`);
}

export function evaluateSuccess(check, dir) {
	if (check.type === "file_exists") {
		const paths = check.paths ?? [check.path];
		return paths.every((p) => typeof p === "string" && fs.existsSync(path.join(dir, p)));
	}
	if (check.type === "file_contains") {
		const target = path.join(dir, check.path);
		if (!fs.existsSync(target)) return false;
		return new RegExp(check.pattern, check.flags ?? "").test(fs.readFileSync(target, "utf8"));
	}
	// command_exits_zero — the only remaining type (validated at task-load time).
	const result = run("/bin/sh", ["-c", check.command], dir, check.timeout_s ?? DEFAULT_CHECK_TIMEOUT_S);
	return result.status === 0;
}

export function readActivityLines(dir) {
	const activityPath = path.join(dir, ".interlinked", "activity.jsonl");
	if (!fs.existsSync(activityPath)) return [];
	return fs.readFileSync(activityPath, "utf8").split("\n");
}

export function harvestRulesStats(dir) {
	const statsPath = path.join(dir, ".interlinked", "rules-stats.json");
	if (!fs.existsSync(statsPath)) return null;
	try {
		const stats = parseJsonFile(statsPath);
		const rules = Array.isArray(stats.rules)
			? stats.rules.filter((rule) => (rule.block ?? 0) > 0 || (rule.warn ?? 0) > 0)
			: [];
		return { generated_at: stats.generated_at ?? null, rules };
	} catch (err) {
		return { error: String(err.message || err).slice(0, 200) };
	}
}

export async function loadMetricsModule() {
	const distPath = path.join(REPO_ROOT, "dist", "harness", "eval-metrics.js");
	if (fs.existsSync(distPath)) return import(pathToFileURL(distPath).href);
	const srcUrl = pathToFileURL(path.join(REPO_ROOT, "src", "harness", "eval-metrics.ts")).href;
	try {
		const { tsImport } = await import("tsx/esm/api");
		return await tsImport(srcUrl, import.meta.url);
	} catch (err) {
		throw new Error(
			"cannot load eval-metrics: no dist/harness/eval-metrics.js (current `npm run build` does not emit it) and the " +
				`tsx fallback failed — run npm install so the repo's tsx devDependency can load src/harness/eval-metrics.ts (${err.message})`,
		);
	}
}
