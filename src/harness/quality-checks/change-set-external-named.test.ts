// ===========================================
// ChangeSet named external checks — behavior tests
// ===========================================
// Exercises `runNamedChecksAdmitted` directly (the sibling
// `change-set-external.test.ts` drives it through the whole batch). Both
// named checks own a runner, so the four process seams are mocked and every
// other collaborator runs for real:
//
//   ../language-profiles.js        → getProfileForFile (affected-test gating)
//   ../test-scheduler.js         → scheduleTests (vitest related)
//   ./dependency-audit.js          → resolveDependencyAuditCommandAsync
//   ../check-engine/spawn-async.js → runProcessAsync (the audit process)
//
// The audit output parsers (`parseOsvScannerJson` / `parseNpmAuditJson`) and
// the pre-existing-failure classifier are the REAL implementations, so the
// fixtures below are real runner JSON and real runner output.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QualityCheckConfig } from "../types.js";
import type {
	DeferredCheck,
	NamedExternalCandidate,
} from "./change-set-external-candidates.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./result-types.js";

const { getProfileForFile, scheduleTests, resolveDependencyAuditCommandAsync, runProcessAsync } =
	vi.hoisted(() => ({
		getProfileForFile: vi.fn(),
		scheduleTests: vi.fn(),
		resolveDependencyAuditCommandAsync: vi.fn(),
		runProcessAsync: vi.fn(),
	}));

vi.mock("../language-profiles.js", () => ({ getProfileForFile }));
vi.mock("../test-scheduler.js", () => ({ scheduleTests }));
vi.mock("./dependency-audit.js", () => ({ resolveDependencyAuditCommandAsync }));
vi.mock("../check-engine/spawn-async.js", () => ({ runProcessAsync }));

import { runNamedChecksAdmitted } from "./change-set-external-named.js";

function namedCheck(overrides: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".ts"],
		timeout_ms: 5_000,
		severity: "error",
		...overrides,
	};
}

function testsCandidate(overrides: Partial<QualityCheckConfig> = {}): NamedExternalCandidate {
	return { name: "affected_tests", check: namedCheck(overrides) };
}

function auditCandidate(fileTypes: string[]): NamedExternalCandidate {
	return {
		name: "dependency_audit",
		check: namedCheck({ file_types: fileTypes, use_osv_scanner: false }),
	};
}

function processResult(overrides: {
	code?: number | null;
	stdout?: string;
	stderr?: string;
	timedOut?: boolean;
	killed?: boolean;
}) {
	return {
		code: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		killed: false,
		...overrides,
	};
}

/** One `runNamedChecksAdmitted` call with fresh output collectors. */
async function runNamed(input: {
	paths: readonly string[];
	affectedTests?: NamedExternalCandidate;
	dependencyAudit?: NamedExternalCandidate;
}) {
	const resultMap = new Map<string, QualityCheckResult[]>();
	const deferred: DeferredCheck[] = [];
	const checksRan: string[] = [];
	const toolMetrics: ToolBreakdownEntry[] = [];
	await runNamedChecksAdmitted(
		{ outChecksRan: checksRan, outToolMetrics: toolMetrics },
		resultMap,
		"/repo",
		input.paths,
		input.affectedTests,
		input.dependencyAudit,
		deferred,
	);
	return { resultMap, deferred, checksRan, toolMetrics };
}

beforeEach(() => {
	getProfileForFile.mockReset();
	getProfileForFile.mockReturnValue({
		id: "typescript",
		test_runner: { command: "npx vitest run" },
	});
	scheduleTests.mockReset();
	scheduleTests.mockResolvedValue({ status: "passed", durationMs: 12, output: "" });
	resolveDependencyAuditCommandAsync.mockReset();
	resolveDependencyAuditCommandAsync.mockResolvedValue({
		cmd: ["npm", "audit", "--json", "--audit-level=moderate"],
		parser: "npm-audit",
	});
	runProcessAsync.mockReset();
	runProcessAsync.mockResolvedValue(processResult({ code: 0 }));
});

describe("runNamedChecksAdmitted — affected tests", () => {
    it("sends the whole changed input union and applies a test-file budget", async () => {
        await runNamed({ paths: ["/repo/src/a.ts", "/repo/src/b.test.ts"],
            affectedTests: testsCandidate({ max_dependent_tests: 2 }) });
        expect(scheduleTests).toHaveBeenCalledWith({ root: "/repo",
            paths: ["/repo/src/a.ts", "/repo/src/b.test.ts"], timeoutMs: 5000, maxTests: 2, maxWorkers: 2, waitForCapacity: false });
    });
    it.each(["deferred", "stale", "empty"])("records no measured check for %s", async status => {
        scheduleTests.mockResolvedValue({ status, reason: "No current verdict" });
        const result = await runNamed({ paths: ["/repo/src/a.ts"], affectedTests: testsCandidate() });
        expect(result.deferred).toEqual([{ name: "affected_tests", reason: "No current verdict" }]);
        expect(result.checksRan).toEqual([]);
    });
    it("attributes failure to a changed input with the shared runner evidence", async () => {
        scheduleTests.mockResolvedValue({ status: "failed", output: "AssertionError: expected 3 to be 4", durationMs: 42 });
        const result = await runNamed({ paths: ["/repo/src/a.ts", "/repo/src/b.ts"], affectedTests: testsCandidate() });
        expect(result.resultMap.get("/repo/src/a.ts")).toEqual([expect.objectContaining({
            name: "affected_tests", severity: "error", message: "Tests failed for 2 changed input(s) (shared test plan)",
            detail: "AssertionError: expected 3 to be 4" })]);
        expect(result.checksRan).toEqual(["affected_tests"]);
        expect(result.toolMetrics).toEqual([{ tool: "affected-tests", ms: 42, finding_count: 1 }]);
    });
});

describe("runNamedChecksAdmitted — dependency audit", () => {
	it("defers when the ChangeSet spans two dependency ecosystems", async () => {
		const { deferred } = await runNamed({
			paths: ["/repo/requirements.txt", "/repo/Cargo.toml"],
			dependencyAudit: auditCandidate(["requirements.txt", "Cargo.toml"]),
		});

		expect(deferred).toEqual([
			{
				name: "dependency_audit",
				reason:
					"the ChangeSet spans multiple dependency ecosystems; one audit cannot cover them",
			},
		]);
		expect(resolveDependencyAuditCommandAsync).not.toHaveBeenCalled();
	});

	it("ignores a manifest path in no known ecosystem and audits the one ecosystem that remains", async () => {
		resolveDependencyAuditCommandAsync.mockResolvedValue({
			cmd: ["govulncheck", "./..."],
			parser: "govulncheck",
		});

		const { deferred, checksRan, toolMetrics } = await runNamed({
			paths: ["/repo/go.mod", "/repo/notes.lock"],
			dependencyAudit: auditCandidate(["go.mod", ".lock"]),
		});

		expect(deferred).toEqual([]);
		expect(runProcessAsync).toHaveBeenCalledWith("govulncheck", ["./..."], {
			cwd: "/repo",
			timeout: 5_000,
		});
		expect(checksRan).toEqual(["dependency_audit"]);
		expect(toolMetrics[0]?.finding_count).toBe(0);
	});

	it("defers when no audit command resolves for the manifest", async () => {
		resolveDependencyAuditCommandAsync.mockResolvedValue(null);

		const { deferred } = await runNamed({
			paths: ["/repo/package.json"],
			dependencyAudit: auditCandidate(["package.json"]),
		});

		expect(deferred).toEqual([
			{ name: "dependency_audit", reason: "dependency audit command is unavailable" },
		]);
		expect(runProcessAsync).not.toHaveBeenCalled();
	});

	it("defers as interrupted when the audit exits with a signal-translated code", async () => {
		runProcessAsync.mockResolvedValue(processResult({ code: 137 }));

		const { deferred, checksRan } = await runNamed({
			paths: ["/repo/package.json"],
			dependencyAudit: auditCandidate(["package.json"]),
		});

		expect(deferred).toEqual([
			{ name: "dependency_audit", reason: "dependency audit was interrupted" },
		]);
		expect(checksRan).toEqual([]);
	});

	it("defers as unavailable when the audit runner never produced an exit code", async () => {
		runProcessAsync.mockResolvedValue(processResult({ code: null }));

		const { deferred } = await runNamed({
			paths: ["/repo/package.json"],
			dependencyAudit: auditCandidate(["package.json"]),
		});

		expect(deferred).toEqual([
			{ name: "dependency_audit", reason: "dependency audit runner was unavailable" },
		]);
	});

	it("reports the osv-scanner severity tally and sampled ids as the finding detail", async () => {
		resolveDependencyAuditCommandAsync.mockResolvedValue({
			cmd: ["osv-scanner", "scan", "source", "--format=json", "--lockfile=package.json"],
			parser: "osv-scanner",
		});
		runProcessAsync.mockResolvedValue(
			processResult({
				code: 1,
				stdout: JSON.stringify({
					results: [
						{
							packages: [
								{ groups: [{ ids: ["GHSA-critical-1"], max_severity: "9.8" }] },
							],
						},
					],
				}),
			}),
		);

		const { resultMap, deferred, checksRan } = await runNamed({
			paths: ["/repo/package.json"],
			dependencyAudit: auditCandidate(["package.json"]),
		});

		expect(deferred).toEqual([]);
		expect(resultMap.get("/repo/package.json")).toEqual([
			{
				name: "dependency_audit",
				severity: "error",
				message: "Dependency vulnerabilities found after this 1-file ChangeSet",
				file: "/repo/package.json",
				detail: "1 critical — GHSA-critical-1",
			},
		]);
		expect(checksRan).toEqual(["dependency_audit"]);
	});

	it("defers instead of reporting when the osv-scanner report is not parseable", async () => {
		resolveDependencyAuditCommandAsync.mockResolvedValue({
			cmd: ["osv-scanner", "scan", "source", "--format=json", "--lockfile=package.json"],
			parser: "osv-scanner",
		});
		runProcessAsync.mockResolvedValue(processResult({ code: 1, stdout: "<html>502</html>" }));

		const { resultMap, deferred, checksRan } = await runNamed({
			paths: ["/repo/package.json"],
			dependencyAudit: auditCandidate(["package.json"]),
		});

		expect(deferred).toEqual([
			{ name: "dependency_audit", reason: "audit report was not parseable" },
		]);
		expect(resultMap.size).toBe(0);
		expect(checksRan).toEqual([]);
	});

	it("reports the npm-audit severity counts as the finding detail", async () => {
		runProcessAsync.mockResolvedValue(
			processResult({
				code: 1,
				stdout: JSON.stringify({
					metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 0 } },
				}),
			}),
		);

		const { resultMap, deferred } = await runNamed({
			paths: ["/repo/package.json", "/repo/package-lock.json"],
			dependencyAudit: auditCandidate(["package.json", "package-lock.json"]),
		});

		expect(deferred).toEqual([]);
		expect(resultMap.get("/repo/package.json")).toEqual([
			{
				name: "dependency_audit",
				severity: "error",
				message: "Dependency vulnerabilities found after this 2-file ChangeSet",
				file: "/repo/package.json",
				detail: "1 critical, 2 high",
			},
		]);
	});

	it("defers instead of reporting when the npm audit report is not parseable", async () => {
		runProcessAsync.mockResolvedValue(
			processResult({ code: 1, stdout: "npm ERR! code ENOAUDIT" }),
		);

		const { resultMap, deferred } = await runNamed({
			paths: ["/repo/package.json"],
			dependencyAudit: auditCandidate(["package.json"]),
		});

		expect(deferred).toEqual([
			{ name: "dependency_audit", reason: "npm audit report was not parseable" },
		]);
		expect(resultMap.size).toBe(0);
	});

	it("falls back to the tail of the runner output for an audit parser with no JSON shape", async () => {
		resolveDependencyAuditCommandAsync.mockResolvedValue({
			cmd: ["pip-audit", "-r", "requirements.txt"],
			parser: "pip-audit",
		});
		runProcessAsync.mockResolvedValue(
			processResult({
				code: 1,
				stdout: "Found 1 known vulnerability in 1 package\nrequests 2.0.0 GHSA-pip-1",
			}),
		);

		const { resultMap } = await runNamed({
			paths: ["/repo/requirements.txt"],
			dependencyAudit: auditCandidate(["requirements.txt"]),
		});

		expect(resultMap.get("/repo/requirements.txt")?.[0]?.detail).toBe(
			"Found 1 known vulnerability in 1 package\nrequests 2.0.0 GHSA-pip-1",
		);
	});

	it("reports a fixed detail when a non-JSON audit runner failed silently", async () => {
		resolveDependencyAuditCommandAsync.mockResolvedValue({
			cmd: ["cargo", "audit"],
			parser: "cargo-audit",
		});
		runProcessAsync.mockResolvedValue(processResult({ code: 1, stdout: "", stderr: "" }));

		const { resultMap } = await runNamed({
			paths: ["/repo/Cargo.lock"],
			dependencyAudit: auditCandidate(["Cargo.lock"]),
		});

		expect(resultMap.get("/repo/Cargo.lock")?.[0]?.detail).toBe("vulnerabilities found");
	});

	it("defers with the thrown error's message when the audit command resolver rejects", async () => {
		resolveDependencyAuditCommandAsync.mockRejectedValue(new Error("resolver blew up"));

		const { deferred, resultMap } = await runNamed({
			paths: ["/repo/package.json"],
			dependencyAudit: auditCandidate(["package.json"]),
		});

		expect(deferred).toEqual([
			{ name: "dependency_audit", reason: "Error: resolver blew up" },
		]);
		expect(resultMap.size).toBe(0);
	});
});
