// ============================================================
// Push-time gate: project test suite must pass
// ============================================================

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { describeDeath, diedBySignal } from "./project-gate-process.js";
import { runBoundedTestProcess } from "./quality-checks/test-process-gate.js";
import type { CheckResultEntry } from "./types.js";
import type { ProjectProcessObserver } from "./project-process-observation.js";

const TESTS_TIMEOUT_MS = 300_000;
const MAX_TEST_FAILURES_REPORTED = 10;

export interface ResolvedTestCommand {
	bin: string;
	args: string[];
	source: "npm-test" | "npm-run-test";
}

/** Resolve the project's test command. Returns null when no `test` script is declared. */
export function resolveTestCommand(cwd: string): ResolvedTestCommand | null {
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return null;
	let pkg: { scripts?: Record<string, string> } | null = null;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch {
		return null;
	}
	if (!pkg?.scripts?.test) return null;
	return { bin: "npm", args: ["test", "--silent"], source: "npm-test" };
}

/** Parse Vitest's standard failure-summary rows, preserving source order. */
export function parseTestFailures(stdout: string): string[] {
	const failures: string[] = [];
	for (const line of stdout.split("\n")) {
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		const match = stripped.match(/^\s*(?:×|✗|FAIL)\s+(.+)$/);
		if (!match) continue;
		const message = nonNull(match[1]).trim();
		if (!failures.includes(message)) failures.push(message);
	}
	return failures;
}

export function checkProjectTestsClean(cwd: string): CheckResultEntry[] {
	if (process.env.INTERLINKED_SKIP_PROJECT_TESTS === "1") {
		return [
			{
				source: "structural",
				name: "project_tests_skipped",
				severity: "warning",
				message:
					"Project test gate bypassed via INTERLINKED_SKIP_PROJECT_TESTS=1. Verify CI manually before merging.",
				determinism: "fully_deterministic",
			},
		];
	}

	const cmd = resolveTestCommand(cwd);
	if (!cmd) return [];
	const result = spawnSync(cmd.bin, cmd.args, {
		cwd,
		encoding: "utf-8",
		timeout: TESTS_TIMEOUT_MS,
	});
	if (result.error) {
		return [
			{
				source: "structural",
				name: "project_tests_failed_to_run",
				severity: "warning",
				message: `Project tests (${cmd.source}) could not run: ${result.error.message}. Verify CI manually.`,
				determinism: "fully_deterministic",
			},
		];
	}
	if (diedBySignal(result)) {
		return [
			{
				source: "structural",
				name: "project_tests_timed_out",
				severity: "warning",
				message: `Project tests (${cmd.source}) exceeded ${TESTS_TIMEOUT_MS / 1000}s timeout or was terminated (${describeDeath(result)}). Verify CI manually.`,
				determinism: "fully_deterministic",
			},
		];
	}
	if (result.status === 0) return [];

	const failures = parseTestFailures(`${result.stdout || ""}\n${result.stderr || ""}`);
	if (failures.length === 0) {
		const raw = (result.stdout || result.stderr || "").trim().slice(0, 500);
		return [
			{
				source: "structural",
				name: "project_tests_clean",
				severity: "error",
				message: `Project tests (${cmd.source}) failed (exit ${result.status}) but no failure list parsed. Raw tail: ${raw}`,
				determinism: "fully_deterministic",
			},
		];
	}
	return failures.slice(0, MAX_TEST_FAILURES_REPORTED).map((failure) => ({
		source: "structural",
		name: "project_tests_clean",
		severity: "error" as const,
		message: failure,
		determinism: "fully_deterministic",
	}));
}

/** Daemon-safe push test gate with bounded, shared test-process admission. */
export async function checkProjectTestsCleanAsync(
	cwd: string,
	options: { admissionAlreadyHeld?: boolean; observe?: ProjectProcessObserver } = {},
): Promise<CheckResultEntry[]> {
	if (process.env.INTERLINKED_SKIP_PROJECT_TESTS === "1") {
		return [
			{
				source: "structural",
				name: "project_tests_skipped",
				severity: "warning",
				message:
					"Project test gate bypassed via INTERLINKED_SKIP_PROJECT_TESTS=1. Verify CI manually before merging.",
				determinism: "fully_deterministic",
			},
		];
	}

	const cmd = resolveTestCommand(cwd);
	if (!cmd) return [];
	const run = await runBoundedTestProcess({
		command: cmd.bin,
		args: cmd.args,
		cwd,
		timeoutMs: TESTS_TIMEOUT_MS,
		...(options.admissionAlreadyHeld ? { admissionAlreadyHeld: true } : {}),
        ...(options.observe ? { observe: options.observe } : {}),
	});
	if (run.kind === "deferred") {
		return [
			{
				source: "structural",
				name: "project_tests_deferred",
				severity: "warning",
				message: `Project tests (${cmd.source}) were NOT CHECKED (${run.reason}). Retry before pushing.`,
				determinism: "fully_deterministic",
			},
		];
	}
	if (run.code === 0) return [];

	const output = `${run.stdout}\n${run.stderr}`;
	const failures = parseTestFailures(output);
	if (failures.length === 0) {
		return [
			{
				source: "structural",
				name: "project_tests_clean",
				severity: "error",
				message: `Project tests (${cmd.source}) failed (exit ${run.code}) but no failure list parsed. Raw tail: ${output.trim().slice(0, 500)}`,
				determinism: "fully_deterministic",
			},
		];
	}
	return failures.slice(0, MAX_TEST_FAILURES_REPORTED).map((failure) => ({
		source: "structural" as const,
		name: "project_tests_clean",
		severity: "error" as const,
		message: failure,
		determinism: "fully_deterministic" as const,
	}));
}
