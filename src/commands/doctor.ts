// ===========================================
// interlinked doctor — Diagnose and fix issues
// ===========================================

import { getClient } from "../lib/api-client.js";
import { resolveAuthToken } from "../lib/auth.js";
import { getCollectionLiveness } from "../lib/collection/liveness.js";
import { getConfigDir, resolveConfig } from "../lib/config.js";
import { c, divider, header } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";
import { adoptionArtifactChecks } from "./adopt.js";
import { resolve } from "node:path";
import { resolveHookBinaryPath } from "../lib/hooks.js";
import { thinkingCaptureCheck } from "./doctor-capture.js";
import { installedHookDriftChecks } from "./doctor-install-drift.js";
import { postureEnumChecks } from "./doctor-posture.js";
import {
	authTokenCheck,
	type CheckResult,
	clientHookChecks,
	collectionLivenessCheck,
	harnessChecks,
	hookVersionChecks,
	legacyConfigCheck,
	localFileChecks,
	metricCapsConfigCheck,
	permissionRuleChecks,
	sessionFileChecks,
	statusIcon,
	systemChecks,
} from "./doctor-checks.js";
import { countVerifiedOrphans } from "./doctor-system.js";
import { skillInstallationChecks } from "./doctor-skills.js";
import { probeHarnessLive } from "./harness-liveness.js";
import { isHarnessRunning } from "./harness.js";

/** Minimal structural view of the health-check result fields doctor reads. */
interface ServerHealth {
	serverReachable: boolean;
	authenticated: boolean;
	serverVersion?: string | undefined;
	error?: string | undefined;
}
type DoctorClient = ReturnType<typeof getClient>;

/** Server-reachable + auth-valid rows derived from a health-check result. */
function serverIdentityChecks(health: ServerHealth, serverUrl: string): CheckResult[] {
	const out: CheckResult[] = [];
	if (health.serverReachable) {
		out.push({ name: "Server reachable", status: "pass", message: `Connected to ${serverUrl}` });
	} else {
		out.push({
			name: "Server reachable",
			status: "fail",
			message: health.error || "Server unreachable",
		});
	}
	if (health.authenticated) {
		out.push({
			name: "Auth valid",
			status: "pass",
			message: health.serverVersion ? `Server v${health.serverVersion}` : "Authenticated",
		});
	} else if (health.serverReachable) {
		out.push({
			name: "Auth valid",
			status: "fail",
			message: `${health.error || "Authentication failed"} -- run 'interlinked login'`,
		});
	}
	return out;
}

/** Registry-workspace + active-workspace-codebase access rows (both require an
 *  authenticated client). Each network call is independently fault-isolated. */
async function workspaceAccessChecks(client: DoctorClient): Promise<CheckResult[]> {
	const out: CheckResult[] = [];
	// Registry workspaces (same source as `interlinked workspace list`).
	try {
		const wsCount = (await client.fetchWorkspaces()).length;
		out.push({
			name: "Registry workspace access",
			status: wsCount > 0 ? "pass" : "warn",
			message: wsCount > 0 ? `${wsCount} workspace(s) accessible` : "No registry workspaces found",
		});
	} catch (e) {
		out.push({
			name: "Registry workspace access",
			status: "fail",
			message: e instanceof Error ? e.message : "Could not list registry workspaces",
		});
	}
	// Internal codebases in the active workspace DO context — a different scope
	// than registry workspaces; can be >1 inside a single ws_ membership.
	try {
		// `callTool` returns `unknown` cast to the requested shape internally
		// (it asserts a parsed HTTP body `as T` with no runtime validation), so
		// the response can genuinely be any JSON value at runtime — narrow it
		// here instead of trusting the assumed shape.
		const wsResult: unknown = await client.callTool("list_workspaces", {});
		const wsWorkspaces =
			typeof wsResult === "object" && wsResult !== null
				? (wsResult as { workspaces?: unknown }).workspaces
				: undefined;
		const codebaseCount = Array.isArray(wsWorkspaces) ? wsWorkspaces.length : 0;
		out.push({
			name: "Codebase access (active workspace)",
			status: codebaseCount > 0 ? "pass" : "warn",
			message:
				codebaseCount > 0
					? `${codebaseCount} codebase(s) in active workspace`
					: "No codebases found in active workspace",
		});
	} catch (e) {
		out.push({
			name: "Codebase access (active workspace)",
			status: "warn",
			message: e instanceof Error ? e.message : "Could not list codebases in active workspace",
		});
	}
	return out;
}

/** Server checks (need auth). Returns a skipped-warning when no token is
 *  available; otherwise probes health, identity, and workspace access. */
async function serverChecks(
	token: string | null,
	resolvedConfig: { server_url: string },
): Promise<CheckResult[]> {
	if (!token) {
		return [
			{ name: "Server checks", status: "warn", message: "Skipped -- no auth token available" },
		];
	}
	try {
		const client = getClient();
		const health = await client.healthCheck();
		const out = serverIdentityChecks(health, resolvedConfig.server_url);
		if (health.authenticated) {
			out.push(...(await workspaceAccessChecks(client)));
		}
		return out;
	} catch (e) {
		return [
			{
				name: "Server reachable",
				status: "fail",
				message: e instanceof Error ? e.message : "Connection failed",
			},
		];
	}
}

export async function doctorCommand(opts: { fix?: boolean; json?: boolean }): Promise<void> {
	const cwd = process.cwd();
	const results: CheckResult[] = [];
	const resolvedConfig = resolveConfig(cwd);
	const isLocalDevServer =
		resolvedConfig.server_url.includes("localhost") ||
		resolvedConfig.server_url.includes("127.0.0.1");

	// ===========================================
	// System checks (CPU / memory / orphan daemons)
	// ===========================================
	// Phase E.1 — `interlinked doctor` surfaces system signals before
	// configuration ones. CPU/RAM/orphan-count problems matter even when
	// the rest of the install is fine, and they're the most common cause
	// of latency-budget overruns and runaway memory growth in the wild.
	// Count orphans through the SAME verified sweep `harness status` and
	// `harness reap` use — it resolves which daemons are actually answering and
	// protects them. Doctor's private `ps` scan called the live daemon an
	// orphan (a daemon is re-parented to pid 1 by definition) and offered a
	// reap that would have killed it.
	const orphanCount = await countVerifiedOrphans(cwd);
	results.push(...systemChecks(orphanCount));

	// ===========================================
	// Local Checks (no server needed)
	// ===========================================

	// 1–4. Config dir / shared / local config / agent identity / hook presence
	const configDir = getConfigDir(cwd);
	results.push(...localFileChecks(cwd, resolvedConfig));
	results.push(metricCapsConfigCheck(cwd));

	// 4c. Data collection liveness — is the canonical collection.jsonl stream
	// advancing? This is the guard the legacy activity.jsonl never had: a stream
	// that silently stops recording (unwired hook, dead daemon, full disk) shows
	// up here instead of being discovered days later.
	const liveness = getCollectionLiveness(cwd);
	results.push({ name: "Data collection", ...collectionLivenessCheck(liveness) });

	// 4d. Thinking-capture health — are recent tool calls carrying reasoning
	// traces? Catches a silent regression of the live hook→daemon capture path
	// (the class that went unnoticed for weeks before the live-capture port).
	results.push(thinkingCaptureCheck(cwd));

	// 4b. Hook script version check (only when the .interlinked hook exists)
	results.push(...hookVersionChecks(cwd, opts.fix === true));

	// 5. Client hooks installed
	results.push(...clientHookChecks(cwd));

	// 5-drift. Semantic verification of every manifest-tracked install — the
	// same verifier the refresh command uses (review 2026-08-30: the check
	// above only proves SOME Interlinked command exists, not a current one).
	results.push(...installedHookDriftChecks(cwd, resolve(resolveHookBinaryPath(cwd, { writeFallback: false }))));
	// 5-enums. Invalid posture-enum values the loader silently drops.
	results.push(...postureEnumChecks(cwd));

	// 5a. Native agent skill copies current for every detected client.
	results.push(...skillInstallationChecks(cwd, opts.fix === true));

	// 5b. Permission-rule hygiene across Claude Code settings files.
	// Claude Code's "Always allow" extractor occasionally writes rules with
	// mismatched parentheses (e.g. `Bash(-d) && cd && echo ... *)`) which
	// Claude Code's own /doctor flags as "Invalid permission rule ... was
	// skipped". We can't prevent the upstream write, but we can scan all known
	// settings files and (with --fix) strip them.
	results.push(...permissionRuleChecks(cwd, opts.fix === true));

	// 6. Auth token present
	const token = resolveAuthToken(cwd);
	results.push(authTokenCheck(token, isLocalDevServer));

	// 7. Legacy config detected (+ --fix migration)
	results.push(...legacyConfigCheck(cwd, opts.fix === true));

	// 8. Stale session files
	results.push(...sessionFileChecks(cwd));

	// ===========================================
	// Harness Checks (9–11): Node runtime + harness server + guard rules
	// ===========================================
	// Probe the socket for real before judging the daemon: a live pid proves
	// only that a process exists, and the process that answers nothing is the
	// one users most need to be told about (audit F1).
	const harnessAnswered = await probeHarnessLive(cwd, isHarnessRunning(cwd).running);
	results.push(...harnessChecks(cwd, configDir, harnessAnswered));

	// 12. Adoption artifacts — are the ratchet baselines + trigram index
	// present (and the coverage baseline non-empty)? Missing artifacts mean
	// verify screams on legacy repos and the ratchets are inert; the fix is
	// one command: `interlinked adopt`.
	results.push(...adoptionArtifactChecks(cwd));

	// ===========================================
	// Server Checks (need auth)
	// ===========================================

	const serverResults = await serverChecks(token, resolvedConfig);

	// ===========================================
	// Output
	// ===========================================
	renderDoctorResults(opts, results, serverResults);
}

function renderDoctorResults(
	opts: { fix?: boolean; json?: boolean },
	results: CheckResult[],
	serverResults: CheckResult[],
): void {
	const mode = getOutputMode(opts);
	const allResults = [...results, ...serverResults];

	output(mode, allResults, {
		json: () => ({
			local: results,
			server: serverResults,
			summary: {
				pass: allResults.filter((r) => r.status === "pass").length,
				fail: allResults.filter((r) => r.status === "fail").length,
				warn: allResults.filter((r) => r.status === "warn").length,
			},
		}),
		normal: () => {
			const lines: string[] = [];

			lines.push(header("Local Checks"));
			for (const r of results) {
				lines.push(`  ${statusIcon(r.status)} ${r.name} -- ${r.message}`);
			}

			lines.push("");
			lines.push(header("Server Checks"));
			for (const r of serverResults) {
				lines.push(`  ${statusIcon(r.status)} ${r.name} -- ${r.message}`);
			}

			// Summary line
			const passCount = allResults.filter((r) => r.status === "pass").length;
			const failCount = allResults.filter((r) => r.status === "fail").length;
			const warnCount = allResults.filter((r) => r.status === "warn").length;

			lines.push("");
			lines.push(divider());
			const summaryParts: string[] = [];
			summaryParts.push(c.green(`${passCount} passed`));
			if (failCount > 0) summaryParts.push(c.red(`${failCount} failed`));
			if (warnCount > 0) summaryParts.push(c.yellow(`${warnCount} warnings`));
			lines.push(`  ${summaryParts.join(", ")}`);

			if (failCount > 0 && !opts.fix) {
				lines.push(c.dim("\n  Run 'interlinked doctor --fix' to attempt auto-fixes."));
			}

			return lines.join("\n");
		},
	});

	if (allResults.some((r) => r.status === "fail")) {
		process.exitCode = 1;
	}
}
