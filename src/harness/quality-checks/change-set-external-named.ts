import { basename } from "node:path";
import { parseNpmAuditJson, parseOsvScannerJson } from "../check-engine/output-parsers.js";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { getProfileForFile } from "../language-profiles.js";
import type {
	DeferredCheck,
	NamedExternalCandidate,
} from "./change-set-external-candidates.js";
import { pathMatchesCheck } from "./change-set-external-candidates.js";
import { pushResult } from "./change-set-result-map.js";
import { resolveDependencyAuditCommandAsync } from "./dependency-audit.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./result-types.js";
import { scheduleTests } from "../test-scheduler.js";

interface NamedRunOptions {
	recovery?: boolean;
	outToolMetrics?: ToolBreakdownEntry[];
	outChecksRan?: string[];
}

function outputTail(stdout: string, stderr: string): string {
	return `${stderr}\n${stdout}`.trim().split("\n").slice(-8).join("\n");
}

async function runAffectedTestsAdmitted(
    options: NamedRunOptions,
    resultMap: Map<string, QualityCheckResult[]>,
    projectRoot: string,
    paths: readonly string[],
    candidate: NamedExternalCandidate,
): Promise<DeferredCheck | null> {
    if (!paths.some(path => pathMatchesCheck(path, candidate.check))) return null;
    const inputs = [...paths];
    const profiles = inputs.map(path => getProfileForFile(path)).filter(profile => profile !== null && profile !== undefined);
    if (!profiles.every(profile => profile.id === "typescript" && (profile.test_runner?.command ?? "npx vitest run").includes("vitest"))) {
        return { name: candidate.name, reason: "mixed-language ChangeSets have no single bounded affected-test command" };
    }
    const result = await scheduleTests({ root: projectRoot, paths: inputs, timeoutMs: candidate.check.timeout_ms,
        maxTests: candidate.check.max_dependent_tests ?? 150, maxWorkers: 2, waitForCapacity: false });
    if (result.status === "deferred" || result.status === "stale") return { name: candidate.name, reason: result.reason };
    if (result.status === "empty") return { name: candidate.name, reason: result.reason };
    options.outChecksRan?.push(candidate.name);
    options.outToolMetrics?.push({ tool: "affected-tests", ms: result.durationMs, finding_count: result.status === "failed" ? 1 : 0 });
    if (result.status === "failed") {
        pushResult(resultMap, inputs[0] ?? projectRoot, { name: candidate.name, severity: candidate.check.severity,
            message: `Tests failed for ${inputs.length} changed input(s) (shared test plan)`, file: inputs[0] ?? projectRoot, detail: result.output });
    }
    return null;
}

type DependencyFamily = "node" | "python" | "rust" | "go";

function dependencyFamily(path: string): DependencyFamily | null {
	const name = basename(path);
	if (["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"].includes(name))
		return "node";
	if (["requirements.txt", "pyproject.toml", "Pipfile.lock"].includes(name)) return "python";
	if (["Cargo.toml", "Cargo.lock"].includes(name)) return "rust";
	if (["go.mod", "go.sum"].includes(name)) return "go";
	return null;
}

function parseAuditDetail(
	parser: string,
	stdout: string,
	stderr: string,
): { detail: string } | { reason: string } {
	if (parser === "osv-scanner") {
		const parsed = parseOsvScannerJson(stdout.trim());
		return parsed ? { detail: parsed.detail } : { reason: "audit report was not parseable" };
	}
	if (parser === "npm-audit") {
		const parsed = parseNpmAuditJson(stdout.trim());
		return parsed
			? { detail: parsed.detail }
			: { reason: "npm audit report was not parseable" };
	}
	return { detail: outputTail(stdout, stderr) || "vulnerabilities found" };
}

async function runDependencyAuditAdmitted(
	options: NamedRunOptions,
	resultMap: Map<string, QualityCheckResult[]>,
	projectRoot: string,
	paths: readonly string[],
	candidate: NamedExternalCandidate,
): Promise<DeferredCheck | null> {
	const manifestPaths = paths.filter((path) => pathMatchesCheck(path, candidate.check));
	if (manifestPaths.length === 0) return null;
	const families = new Set(manifestPaths.map(dependencyFamily).filter((family) => family !== null));
	if (families.size !== 1) {
		return {
			name: candidate.name,
			reason: "the ChangeSet spans multiple dependency ecosystems; one audit cannot cover them",
		};
	}
	const primaryPath = manifestPaths[0];
	if (!primaryPath) return null;
	const resolved = await resolveDependencyAuditCommandAsync(basename(primaryPath), {
		useOsvScanner: candidate.check.use_osv_scanner,
		offline: candidate.check.offline,
	});
	const command = resolved?.cmd[0];
	if (!resolved || !command) {
		return { name: candidate.name, reason: "dependency audit command is unavailable" };
	}
	const started = Date.now();
	const outcome = await runProcessAsync(command, resolved.cmd.slice(1), {
		cwd: projectRoot,
		timeout: candidate.check.timeout_ms,
	});
	if (outcome.timedOut) return { name: candidate.name, reason: "dependency audit timed out" };
	if (outcome.killed || (outcome.code !== null && outcome.code >= 128)) {
		return { name: candidate.name, reason: "dependency audit was interrupted" };
	}
	if (outcome.code === null) {
		return { name: candidate.name, reason: "dependency audit runner was unavailable" };
	}
	options.outToolMetrics?.push({
		tool: "dependency-audit",
		ms: Date.now() - started,
		finding_count: outcome.code === 0 ? 0 : 1,
	});
	if (outcome.code === 0) {
		options.outChecksRan?.push(candidate.name);
		return null;
	}

	const parsed = parseAuditDetail(resolved.parser, outcome.stdout, outcome.stderr);
	if ("reason" in parsed) return { name: candidate.name, reason: parsed.reason };
	options.outChecksRan?.push(candidate.name);
	pushResult(resultMap, primaryPath, {
		name: candidate.name,
		severity: candidate.check.severity,
		message: `Dependency vulnerabilities found after this ${manifestPaths.length}-file ChangeSet`,
		file: primaryPath,
		detail: parsed.detail,
	});
	return null;
}

export async function runNamedChecksAdmitted(
	options: NamedRunOptions,
	resultMap: Map<string, QualityCheckResult[]>,
	projectRoot: string,
	projectPaths: readonly string[],
	affectedTests: NamedExternalCandidate | undefined,
	dependencyAudit: NamedExternalCandidate | undefined,
	deferred: DeferredCheck[],
): Promise<void> {
	if (dependencyAudit) {
		try {
			const reason = await runDependencyAuditAdmitted(
				options,
				resultMap,
				projectRoot,
				projectPaths,
				dependencyAudit,
			);
			if (reason) deferred.push(reason);
		} catch (error) {
			deferred.push({ name: dependencyAudit.name, reason: String(error) });
		}
	}
	if (affectedTests) {
		try {
			const reason = await runAffectedTestsAdmitted(
				options,
				resultMap,
				projectRoot,
				projectPaths,
				affectedTests,
			);
			if (reason) deferred.push(reason);
		} catch (error) {
			deferred.push({ name: affectedTests.name, reason: String(error) });
		}
	}
}
