import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { currentProcessSignal, withProcessCancellation } from "../process-cancellation.js";
import { runProcessAsync } from "../spawn-async.js";
import { PartialToolReportError, ToolDeadlineError } from "../tool-errors.js";
import type { CheckResult, ToolInputScope } from "../types.js";
import { parseCompleteGitleaksReport, readGenericProcessReport } from "./generic-process-verdict.js";
import { collectGitleaksScope, gitleaksConfiguration, type GitleaksInputScope, type GitleaksScope } from "./gitleaks-scope.js";

async function sourceSnapshot(root: string, scope: GitleaksScope, configurationFile: string | undefined, remaining: () => number): Promise<string> {
	const digest = createHash("sha256");
	const workingFiles = new Set(scope.files.map(file => join(root, file)));
	const files = new Set(workingFiles);
	const canonicalRoot = await realpath(root);
	if (configurationFile) files.add(configurationFile);
	for (const file of [...files].sort()) {
		currentProcessSignal()?.throwIfAborted(); remaining();
		if (workingFiles.has(file)) {
			const rel = relative(canonicalRoot, await realpath(file));
			if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("Gitleaks input escaped the project root");
		}
		digest.update(JSON.stringify(file));
		const hash = createHash("sha256");
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await handle.stat();
			if (!before.isFile()) throw new Error("Gitleaks input is no longer a regular file");
			const stream = handle.createReadStream({ signal: currentProcessSignal(), autoClose: false });
			for await (const chunk of stream) {
				currentProcessSignal()?.throwIfAborted(); remaining(); hash.update(chunk);
			}
			const after = await handle.stat();
			if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Gitleaks input changed during source snapshot");
		} finally { await handle.close(); }
		digest.update(hash.digest());
	}
	return digest.digest("hex");
}

/** Scan actual working inputs, preserving root config and relative fingerprints.
 * A positive timeout bounds discovery, all targets and the final snapshot. */
export async function runGitleaksForeground(root: string, timeoutMs: number, onInputScope?: (scope: ToolInputScope) => void, selection: GitleaksInputScope = "working-tree"): Promise<CheckResult[]> {
	const controller = new AbortController();
	const owner = currentProcessSignal();
	const signal = owner ? AbortSignal.any([owner, controller.signal]) : controller.signal;
	const expiry = () => new ToolDeadlineError("Gitleaks deadline expired; no complete security verdict", []);
	const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(expiry()), timeoutMs) : undefined;
	timer?.unref();
	const deadline = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
	const remaining = (): number => {
		currentProcessSignal()?.throwIfAborted();
		if (performance.now() >= deadline) throw expiry();
		return deadline === Infinity ? 0 : Math.max(1, Math.ceil(deadline - performance.now()));
	};
	try { return await withProcessCancellation(signal, () => scanWorkingInputs(root, remaining, onInputScope, owner, selection)); }
	finally { clearTimeout(timer); }
}

async function scanWorkingInputs(root: string, remaining: () => number, onInputScope: ((scope: ToolInputScope) => void) | undefined, owner: AbortSignal | undefined, selection: GitleaksInputScope): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	let scope: GitleaksScope = { files: [], targets: [], excluded: [], unavailable: [] };
	const unavailable: Array<{ file: string; reason: string }> = [];
	try {
		const configuration = gitleaksConfiguration(root);
		scope = await collectGitleaksScope(root, remaining, selection);
		unavailable.push(...scope.unavailable);
		const before = await sourceSnapshot(root, scope, configuration.file, remaining);
		for (const target of scope.targets) {
			await collectTargetFindings(() => scanTarget(root, target, configuration, remaining()), target, results, unavailable);
		}
		const afterScope = await collectGitleaksScope(root, remaining, selection);
		for (const input of afterScope.unavailable) {
			if (!unavailable.some(existing => existing.file === input.file && existing.reason === input.reason)) unavailable.push(input);
		}
		const after = await sourceSnapshot(root, afterScope, configuration.file, remaining);
		if (before !== after || JSON.stringify(scope) !== JSON.stringify(afterScope)) unavailable.push({ file: "<project>", reason: "Gitleaks working inputs changed during verification" });
	} catch (error) {
		const failure = currentProcessSignal()?.aborted ? currentProcessSignal()?.reason : error;
		unavailable.push({ file: "<project>", reason: failure instanceof Error ? failure.message : "Gitleaks working-input scan unavailable" });
		owner?.throwIfAborted();
		const Failure = failure instanceof ToolDeadlineError ? ToolDeadlineError : PartialToolReportError;
		throw new Failure(unavailable.map(input => `${JSON.stringify(input.file)}: ${input.reason}`).join("\n"), results, { cause: error });
	} finally {
		publishInputScope(scope, unavailable, selection, onInputScope);
	}
	if (unavailable.length) throw new PartialToolReportError(unavailable.map(input => `${JSON.stringify(input.file)}: ${input.reason}`).join("\n"), results);
	return results;
}

async function collectTargetFindings(scan: () => Promise<CheckResult[]>, target: string, results: CheckResult[], unavailable: ToolInputScope["unavailableInputs"]): Promise<void> {
	try { results.push(...await scan()); }
	catch (error) {
		if (error instanceof PartialToolReportError) results.push(...error.results);
		const reason = error instanceof PartialToolReportError ? error.message : "native Gitleaks execution or report incomplete";
		unavailable.push({ file: target, reason });
		currentProcessSignal()?.throwIfAborted();
		if (error instanceof ToolDeadlineError) throw error;
	}
}

function publishInputScope(scope: GitleaksScope, unavailableInputs: ToolInputScope["unavailableInputs"], selection: GitleaksInputScope, publish?: (scope: ToolInputScope) => void): void {
	publish?.({ tool: "gitleaks", selection, selectedFiles: scope.files.length, targets: scope.targets,
		excludedInputs: scope.excluded.map(file => ({ file, reason: file === "<git-ignored>" ? "Explicit git-visible scope omits Git-ignored inputs, including untracked .env files" : file === ".git" ? "Git object/control storage" : "Untracked generated, dependency, history or control contents omitted; tracked working files retained" })),
		unavailableInputs,
		nativeLimitations: ["Configured Gitleaks rules and allowlists remain authoritative", "Native binary detection, archive traversal and recursive decoding limits still apply", "Symbolic and non-regular inputs are unavailable", "External inherited config files are read by Gitleaks and are not frozen by this adapter"],
	});
}

async function scanTarget(root: string, target: string, configuration: ReturnType<typeof gitleaksConfiguration>, timeout: number): Promise<CheckResult[]> {
	const process = await runProcessAsync("gitleaks", ["dir", "--no-banner", "--no-color", "--redact", "--report-format", "json", "--report-path", "-",
		...configuration.args, "--", target], { cwd: root, exactEnv: configuration.env, timeout, maxBufferBytes: null });
	const findings = readGenericProcessReport("gitleaks", process, parseCompleteGitleaksReport);
	// Keep diagnostic content private, including inline config on native failures.
	const diagnosticFailure = process.stderr.split("\n").some(line => /\b(?:FTL|ERR|WRN)\b/.test(line) && !/\bWRN\b.*\bleaks found:\s*\d+\s*$/.test(line));
	if (diagnosticFailure || /permission denied|skipping (?:file|directory)|issue reading file|could not read file/i.test(process.stderr)) {
		throw new PartialToolReportError("Native Gitleaks reported an incomplete scope", findings);
	}
	return findings;
}
