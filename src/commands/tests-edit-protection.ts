// ===========================================
// `interlinked tests edit-protection [tests...]`
// ===========================================
// Saturation testing's weak point is the requirement-change path: an agent edits
// old tests, and an edit that weakens a test of UNRELATED code removes the
// "semantic stability" the saturated suite was for. This command re-proves every
// kill a kill-proof receipt recorded for each edited test file against the test's
// current bytes (harness/kill-proof/edit-protection.ts) and reports which kills
// were kept, lost, retired by a source change, or undecided.
//
// The change-set is `git diff --name-only <base>` plus untracked files. A loss in
// a source the change-set touched is requirement-linked (reported); a loss in an
// untouched source that no other test still kills is a FINDING.
// Exit: 0 no finding; 1 a finding; 2 undecided rows or a bad argument.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isTestPath } from "../harness/coverage-test-selector.js";
import { assessEditProtection, changedTestsWithKills, DEFAULT_EDIT_PROTECTION_MAX, type EditProtectionResult, editProtectionExitCode, type ProtectionRow } from "../harness/kill-proof/edit-protection.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export interface EditProtectionCliOptions {
	cwd?: string;
	base?: string;
	source?: string[];
	max?: string;
	runTimeout?: string;
	vitestConfig?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function gitLines(root: string, args: readonly string[]): string[] {
	const out = execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return out.split("\n").map(line => line.trim()).filter(line => line.length > 0);
}

/** Paths changed against `base` (modified, added, deleted) plus untracked files, repo-relative. */
export function gitChangeSet(root: string, base: string): string[] {
	const changed = new Set([...gitLines(root, ["diff", "--name-only", base]), ...gitLines(root, ["ls-files", "--others", "--exclude-standard"])]);
	return [...changed].sort();
}

export function splitChangeSet(paths: readonly string[]): { tests: string[]; sources: string[] } {
	return { tests: paths.filter(path => isTestPath(path)), sources: paths.filter(path => !isTestPath(path)) };
}

function positiveInt(value: string | undefined, flag: string, fallback: number): number | string {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) return `${flag} must be a positive integer`;
	return Number(value);
}

function rowLine(row: ProtectionRow, finding: boolean): string {
	const scope = row.collateral ? "collateral" : "requirement-linked";
	const others = row.otherKillers.length > 0 ? ` · still killed by ${row.otherKillers.join(", ")}` : "";
	const why = row.reasons.length > 0 ? `\n      ${row.reasons.join("; ")}` : "";
	return `  ${finding ? "FINDING " : ""}${row.verdict.padEnd(9)} ${scope.padEnd(18)} ${row.test}\n      ${row.label}${others}${why}`;
}

export function renderEditProtection(result: EditProtectionResult): string {
	if (result.rows.length === 0 && result.skipped === 0) return "edit-protection: no edited test file holds a stale killed receipt; nothing to judge.";
	const findings = new Set(result.findings);
	const s = result.summary;
	const lines = ["edit-protection: prior kills of edited tests, re-proved against the current test bytes", ...result.rows.map(row => rowLine(row, findings.has(row)))];
	lines.push(`  ${s.kept} kept · ${s.lost} lost (${s.collateralLost} collateral) · ${s.retired} retired · ${s.undecided} undecided · ${result.findings.length} finding(s)`);
	if (result.skipped > 0) lines.push(`  ${result.skipped} prior kill(s) not judged (raise --max)`);
	if (result.findings.length > 0) lines.push("  A FINDING is a kill the old test proved, in code this change did not touch, that no test still proves. Restore the assertion, or move it to a test that keeps it.");
	return lines.join("\n");
}

export async function testsEditProtectionCommand(options: EditProtectionCliOptions, tests: readonly string[] = []): Promise<void> {
	const mode = getOutputMode(options);
	const max = positiveInt(options.max, "--max", DEFAULT_EDIT_PROTECTION_MAX);
	const budget = positiveInt(options.runTimeout, "--run-timeout", 300_000);
	if (typeof max === "string" || typeof budget === "string") {
		outputError(mode, typeof max === "string" ? max : String(budget));
		process.exitCode = 2;
		return;
	}
	try {
		const root = realpathSync(options.cwd ?? process.cwd());
		const changed = splitChangeSet(gitChangeSet(root, options.base ?? "HEAD"));
		const named = tests.length > 0 ? [...tests] : changedTestsWithKills(root, changed.tests);
		const sources = new Set(options.source ?? changed.sources);
		const result = await assessEditProtection({ root, tests: named, changedSources: sources, budgetMs: budget, max, ...(options.vitestConfig !== undefined ? { vitestConfig: options.vitestConfig } : {}) });
		output(mode, result, { normal: () => renderEditProtection(result) });
		process.exitCode = editProtectionExitCode(result);
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : "edit protection unavailable");
		process.exitCode = 2;
	}
}
