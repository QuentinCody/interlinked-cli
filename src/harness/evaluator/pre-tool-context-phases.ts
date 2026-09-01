// interlinked-tdd: exempt
// ===========================================
// PreToolUse warning-only context phases
// ===========================================
//
// Leaf cluster extracted from pre-tool.ts: the side-effect-only PreToolUse
// phases that never return a block decision (trajectory detector, curl-to-MCP,
// markdown-first nudges, structural context injection, Supermodel graph
// awareness, project-setup validation, file diagnostics, and the pending
// session-warning drain). Each pushes into a shared `warnings` array by
// reference. Moved verbatim; the orchestrator in pre-tool.ts imports them.

import type { SharedConfig } from "../../lib/config.js";
import type { ProjectGraph } from "../project-graph.js";
import type { RouteMap } from "../route-map.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { SessionTracker } from "../session-state.js";
import { getPreToolUseContext } from "../structural-checks.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	evaluateCurlMcpGuards,
	evaluateMarkdownFirstCurlGuard,
	getPreToolUseDiagnostics,
	getProjectSetupWarnings,
	getSupermodelCallContext,
	getSupermodelGraphWarning,
	runTrajectoryDetector,
} from "./pre-tool-helpers.js";
import { extractScannableText } from "./spans.js";
import {
	isBash,
	isBrowserNavigate,
	isFileWrite,
} from "./tool-classifiers.js";

const DIAGNOSTIC_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;

/** The harness event's tool-input bag, normalized to a non-undefined object. */
export type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

/**
 * Phase D.2 trajectory detector — feeds the per-session ring buffer and
 * surfaces any anti-pattern findings as warnings. Lazy: only instantiated
 * when at least one `harness.trajectory.*` flag is enabled (default off, so
 * this is a no-op until the flags flip via SharedConfig override). Warning-only.
 */
export function evaluateTrajectoryDetectorPhase(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	sharedConfig: SharedConfig | null,
	warnings: string[],
): void {
	if (!session) return;
	const trajectoryWarnings = runTrajectoryDetector(event, session, sharedConfig);
	if (trajectoryWarnings.length > 0) warnings.push(...trajectoryWarnings);
}

/**
 * curl-to-MCP detection (Bash only). Only treats repeated localhost curls as an
 * "MCP server may be disconnected" signal when the request targets an
 * MCP-shaped path (/mcp, /sse, /messages). Port presence alone is NOT an MCP
 * signal. Classifies the command's EXECUTED spans only (extractScannableText
 * blanks quoted / comment / heredoc spans), so a commit message that merely
 * mentions curl + /mcp does not fire. Warning-only.
 */
export function evaluateCurlMcpPhase(
	session: SessionTrajectory | undefined,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	if (!isBash(toolName)) return;
	const mcpScanCommand = extractScannableText((toolInput.command as string) || "");
	const targetsMcpPath = /\/(?:mcp|sse|messages?)\b/i.test(mcpScanCommand);
	warnings.push(
		...evaluateCurlMcpGuards({
			mcpScanCommand,
			targetsMcpPath,
			curlMcpDetection: rules.curl_mcp_detection,
			session,
		}),
	);
}

/**
 * Markdown-first web-fetching nudges. The browser-navigate side nudges toward a
 * `curl -H "Accept: text/markdown"` first (Cloudflare Markdown for Agents);
 * the Bash side delegates to the curl-specific guard. Warning-only.
 */
export function evaluateMarkdownFirstPhase(
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	if (isBrowserNavigate(toolName)) {
		const url = (toolInput.url as string) || "";
		if (url && /^https?:\/\//i.test(url)) {
			warnings.push(
				"[interlinked:markdown-first] Browser navigation to read web content is token-expensive. " +
					`Try first: curl -sS -H "Accept: text/markdown" '${url}' — ` +
					"Cloudflare Markdown for Agents returns clean markdown (~80% fewer tokens). " +
					"Use the browser only if the page needs JavaScript rendering or interaction.",
			);
		}
	}
	if (isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";
		warnings.push(...evaluateMarkdownFirstCurlGuard(cmd));
	}
}

/**
 * Structural context injection. Runs only when a project graph, session
 * tracker, and `structural_checks.enabled` are all present. Warning-only.
 */
export function evaluateStructuralContextPhase(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	graph: ProjectGraph | undefined,
	sessions: SessionTracker | undefined,
	session: SessionTrajectory | undefined,
	routeMap: RouteMap | undefined,
	warnings: string[],
): void {
	if (!(graph && sessions && rules.structural_checks.enabled)) return;
	const contextWarnings = getPreToolUseContext(
		event,
		rules.structural_checks,
		graph,
		sessions,
		session,
		routeMap,
	);
	warnings.push(...contextWarnings);
}

/**
 * Supermodel graph awareness — surface blast radius and the function-level
 * call graph from Supermodel-emitted .graph.* shards if the user is running
 * their daemon. Read-only consumer; silent when no shard exists. Loops over
 * every edited path so multi-file Codex apply_patch payloads each get their own
 * warning(s). `isFileWrite()` already includes "apply_patch", so the gate
 * covers Codex too. The [calls] context line is gated behind a firing [impact]
 * line. Warning-only.
 */
export function evaluateSupermodelGraphContext(
	event: HarnessEvent,
	toolName: string,
	warnings: string[],
): void {
	if (!isFileWrite(toolName)) return;
	for (const editedPath of extractAllEditedFilePaths(event)) {
		const graphWarning = getSupermodelGraphWarning(editedPath, event.cwd);
		if (!graphWarning) continue;
		warnings.push(graphWarning);
		const callContext = getSupermodelCallContext(editedPath, event.cwd);
		if (callContext) warnings.push(callContext);
	}
}

/**
 * One-time project-setup validation (first tool call only). Warning-only.
 */
export function evaluateProjectSetupPhase(event: HarnessEvent, warnings: string[]): void {
	const setupWarnings = getProjectSetupWarnings(event.cwd || process.cwd());
	if (setupWarnings.length > 0) warnings.push(...setupWarnings);
}

/**
 * PreToolUse file diagnostics (tsc + biome). Runs only for file-write tools
 * targeting a diagnosable extension when quality checks are enabled.
 * Warning-only.
 */
export function evaluateDiagnosticsPhase(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	// `rules.quality_checks` is typed as required, but a caller can pass a
	// rules object with it explicitly unset (see the N3 mutation-kill test).
	// Read it through `unknown` so the guard stays real (AND-gated, not
	// OR-gated) instead of being lint-dead.
	const qualityChecksPresent: unknown = rules.quality_checks;
	if (!(isFileWrite(toolName) && qualityChecksPresent)) return;
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (filePath && DIAGNOSTIC_EXTENSIONS.test(filePath)) {
		const diagWarnings = getPreToolUseDiagnostics(
			filePath,
			event.cwd || process.cwd(),
			rules.quality_checks,
		);
		warnings.push(...diagWarnings);
	}
}

/**
 * Drain pending session warnings (queued by SessionStart async checks).
 * Warning-only; clears the queue after draining.
 */
export function drainPendingSessionWarnings(
	session: SessionTrajectory | undefined,
	warnings: string[],
): void {
	if (!session) return;
	const carrier = session as SessionTrajectory & { pendingSessionWarnings?: string[] };
	const pending = carrier.pendingSessionWarnings;
	if (pending && pending.length > 0) {
		warnings.push(...pending);
		carrier.pendingSessionWarnings = [];
	}
}
