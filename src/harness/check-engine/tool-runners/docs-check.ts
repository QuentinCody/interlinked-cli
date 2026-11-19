import { spawnSync } from "node:child_process";
import { parseDocsCheckOutput, relativeResultPaths } from "../output-parsers.js";
import { runProcessAsync, type RunProcessResult } from "../spawn-async.js";
import { projectToolInputMissing } from "../tool-applicability.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";
import { requireFileProcessVerdict } from "./file-process-verdict.js";

function interpret(result: RunProcessResult, projectRoot: string): CheckResult[] {
	requireFileProcessVerdict("docs-check", result, 1);
	const findings = relativeResultPaths(parseDocsCheckOutput(`${result.stdout}${result.stderr}`), projectRoot);
	requireFileProcessVerdict("docs-check", result, findings.length);
	return findings;
}

export async function runDocsCheckAsync({ scope, timeoutMs }: ToolRunnerInput): Promise<CheckResult[]> {
	if (projectToolInputMissing("docs-check", scope.projectRoot)) throw new Error("No project-local scripts/check-docs.mjs; no check verdict");
	const result = await runProcessAsync(process.execPath, ["scripts/check-docs.mjs"], { cwd: scope.projectRoot, timeout: timeoutMs });
	return interpret(result, scope.projectRoot);
}

export function runDocsCheck({ scope, timeoutMs }: ToolRunnerInput): CheckResult[] {
	if (projectToolInputMissing("docs-check", scope.projectRoot)) throw new Error("No project-local scripts/check-docs.mjs; no check verdict");
	const result = spawnSync(process.execPath, ["scripts/check-docs.mjs"], { cwd: scope.projectRoot, timeout: timeoutMs, encoding: "utf8" });
	if (result.error) throw result.error;
	return interpret({ code: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: false, killed: result.signal !== null }, scope.projectRoot);
}
