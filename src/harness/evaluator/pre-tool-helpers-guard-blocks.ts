// interlinked-tdd: exempt
// ===========================================
// PreToolUse Evaluation — guard-block helpers
// ===========================================
//
// Git-diff / dirty-dependent / supply-chain / Bash & Read guard-block
// helpers split out of `pre-tool-helpers.ts` to keep that module under the
// per-file line cap (see large-file-policy.ts). These are moved verbatim —
// the logic is identical to the prior inline versions; only the module
// boundary changed. This is a LEAF cluster: nothing here imports back from
// `pre-tool-helpers.ts`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import {
	findDirtyDependents,
	formatDirtyDependentWarning,
	looksCoordinated,
} from "../checks/dirty-dependent.js";
import { isTestFile } from "../checks/shared.js";
import { applyLiteralReplacement } from "../overlay-content.js";
import type { ProjectGraph } from "../project-graph.js";
import type {
	EscalationRequest,
	HarnessDecision,
	SessionTrajectory,
} from "../types.js";
import { detectDropperStaging } from "./dropper-staging.js";
import { hasPublicHttpUrl } from "./network-hosts.js";

const ESCALATION_TAIL_LENGTH = 10;
const LARGE_READ_SIZE_MB = 10;

/** List `git diff` paths (relative to `cwd`) for either the index
 *  (`--cached`) or the working tree (no flag). Returns [] on any error
 *  (not a git repo, git not installed, etc.) so the dirty-dependent
 *  check fails open. */
function listGitDiffPaths(cwd: string, cached: boolean): string[] {
	try {
		const args = ["diff", "--name-only"];
		if (cached) args.push("--cached");
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

/** Shared timeout for the short-lived `git` invocations below. */
const GIT_TIMEOUT_MS = 3000;

/** Run `git diff <extraArgs>` in `cwd` and return its stdout. Returns ""
 *  on any failure so the dirty-dependent precision filter fails open. */
function runGitDiff(cwd: string, extraArgs: readonly string[]): string {
	try {
		return execFileSync("git", ["diff", ...extraArgs], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
	} catch {
		return "";
	}
}

/** Dirty-dependent pre-commit warning entry point. Returns a formatted
 *  warning string when a staged file is import-graph related to an
 *  unstaged-dirty file (a dirty importer or a dirty dependency); null
 *  when the commit is self-contained or git/graph data is missing.
 *
 *  Path normalization: git emits paths relative to the repo root, but
 *  `ProjectGraph` operates on absolute paths. Convert everything to
 *  absolute up front so the BFS walk's visited set and `dirtySet`
 *  membership compare on the same basis; the output then relativizes
 *  for display. */
export function collectDirtyDependentWarning(cwd: string, graph: ProjectGraph): string | null {
	const stagedRel = listGitDiffPaths(cwd, true);
	if (stagedRel.length === 0) return null;
	const dirtyRel = listGitDiffPaths(cwd, false);
	if (dirtyRel.length === 0) return null;

	const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));
	const toRel = (p: string): string => relative(cwd, p) || p;
	const stagedAbs = stagedRel.map(toAbs);
	const dirtyAbs = dirtyRel.map(toAbs);

	// Memoized `git diff` fetch, feeding the `isRelevant` precision filter.
	// Keyed on the argv so the staged (`--cached`) and working-tree diffs
	// of the same file stay distinct.
	const diffCache = new Map<string, string>();
	const diffOf = (gitArgs: readonly string[]): string => {
		const key = gitArgs.join(" ");
		const hit = diffCache.get(key);
		if (hit !== undefined) return hit;
		const text = runGitDiff(cwd, gitArgs);
		diffCache.set(key, text);
		return text;
	};

	const matches = findDirtyDependents({
		stagedFiles: stagedAbs,
		unstagedDirtyFiles: dirtyAbs,
		getImporters: (file) => graph.getDependents(file),
		getDependencies: (file) => graph.getDependencies(file).map((e) => e.toFile),
		isTestFile: (file) => isTestFile(toRel(file)),
		// Precision: drop a candidate when the dirty file's change and the
		// staged change are not coordinated — the dirty file is dirty for an
		// unrelated reason. `looksCoordinated` fails open, so an
		// indeterminate diff keeps the warning.
		isRelevant: (m) =>
			looksCoordinated([
				diffOf(["--cached", "--", toRel(m.staged)]),
				diffOf(["--", toRel(m.dirtyFile)]),
			]),
	});
	if (matches.length === 0) return null;

	// Convert absolute paths back to repo-relative for the human-facing
	// warning. The pair structure is preserved; only the display strings
	// change.
	const display = matches.map((m) => ({
		...m,
		staged: toRel(m.staged),
		dirtyFile: toRel(m.dirtyFile),
	}));
	return formatDirtyDependentWarning({ matches: display });
}

/** Literal old-to-new application shared with the overlay content builder —
 *  see {@link applyLiteralReplacement} in overlay-content.ts for why plain
 *  String.replace (dollar-pattern interpretation) is wrong here. */
const applyReplacement = applyLiteralReplacement;

/**
 * Compute the full post-write content of a file from a Write / Edit /
 * MultiEdit tool_input. Returns null when the operation's shape doesn't
 * map cleanly to a full content (apply_patch, NotebookEdit) — callers
 * skip the supply-chain manifest check on those paths. Replacements are
 * applied literally and honor `replace_all`, mirroring the real Edit tool.
 */
export function computeFullNewContent(
	absPath: string,
	toolInput: JsonObject,
): string | null {
	if (typeof toolInput.content === "string") return toolInput.content;
	const readCurrent = (): string | null => {
		if (!existsSync(absPath)) return "";
		try {
			return readFileSync(absPath, "utf-8");
		} catch {
			return null;
		}
	};
	if (typeof toolInput.new_string === "string" && typeof toolInput.old_string === "string") {
		const current = readCurrent();
		if (current === null) return null;
		return applyReplacement(
			current,
			toolInput.old_string,
			toolInput.new_string,
			toolInput.replace_all === true,
		);
	}
	if (Array.isArray(toolInput.edits)) {
		const current = readCurrent();
		if (current === null) return null;
		let result = current;
		for (const edit of toolInput.edits as unknown[]) {
			if (edit && typeof edit === "object") {
				const oldS = (edit as JsonObject).old_string;
				const newS = (edit as JsonObject).new_string;
				if (typeof oldS === "string" && typeof newS === "string") {
					result = applyReplacement(result, oldS, newS, (edit as JsonObject).replace_all === true);
				}
			}
		}
		return result;
	}
	return null;
}

// ===========================================
// Extracted Bash/Read check-blocks
// ===========================================
//
// These are lifted out of `evaluatePreToolUse` to keep the orchestrator under
// the line cap. Each takes explicit parameters and returns its result; the
// orchestrator invokes it at the same position and applies the result
// identically (push warnings / set escalation / return the block decision).
// No check ordering changed.

/** Result of the pipe-to-bash / RCE / exfiltration Bash block. `block` is the
 *  one early-return decision in that block (env|printenv|set piped to a network
 *  tool); when set the orchestrator returns it immediately. `escalation` is the
 *  (possibly updated) pending escalation — the orchestrator assigns it back. */
export interface ExfilGuardResult {
	warnings: string[];
	block?: HarnessDecision | undefined;
	escalation?: EscalationRequest | undefined;
}

/** GUARD: Pipe-to-bash / remote code execution + curl-data exfiltration +
 *  dirty-dependent pre-commit + /tmp dropper-staging. Verbatim move of the
 *  inline `if (isBash(toolName))` block; reads `cmd` (already extracted by
 *  the caller), `session`, `graph`, `cwd`, and the current `pendingEscalation`.
 *  Returns warnings to append, an optional block decision (the single early
 *  return), and the post-block escalation value. */
export function evaluateExfilGuards(args: {
	cmd: string;
	toolName: string;
	session: SessionTrajectory | undefined;
	graph: ProjectGraph | undefined;
	cwd: string | undefined;
	pendingEscalation: EscalationRequest | undefined;
}): ExfilGuardResult {
	const { cmd, toolName, session, graph, cwd } = args;
	let pendingEscalation = args.pendingEscalation;
	const warnings: string[] = [];

	if (/\b(curl|wget)\b.*\|\s*(ba)?sh\b/i.test(cmd)) {
		warnings.push(
			"[interlinked] Warning: Piping remote content to shell is a security risk. Download first, inspect, then execute.",
		);
	}
	if (/--no-verify\b/i.test(cmd)) {
		warnings.push(
			"[interlinked] Warning: --no-verify bypasses safety hooks. These hooks exist to prevent broken commits.",
		);
	}

	// GUARD: dirty-dependent pre-commit check. When the agent runs
	// `git commit`, walk staged files' transitive importers through the
	// project graph; flag any importer that is dirty-but-unstaged. This
	// catches the failure class that produced commit 7219b48 → red CI:
	// production code committed alone while its consumer test stayed
	// in the working tree, so tests passed locally and broke on the
	// committed snapshot in CI.
	if (/\bgit\s+commit\b/.test(cmd) && graph && cwd) {
		const dd = collectDirtyDependentWarning(cwd, graph);
		if (dd) warnings.push(dd);
	}
	if (
		/\b(curl|wget)\b/i.test(cmd) &&
		/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(cmd) &&
		!pendingEscalation
	) {
		pendingEscalation = {
			trigger: "external_url",
			summary: "Bash command contains curl/wget to external URL",
			tool_name: toolName,
			tool_input_redacted: { command: "[REDACTED — contains external URL]" },
			sensitivity_level: session?.sensitivity_level || "Public",
			step_number: session?.tool_call_count || 0,
			recent_tool_sequence: session?.tool_sequence.slice(-ESCALATION_TAIL_LENGTH) || [],
		};
	}
	if (
		/\bcurl\b.*(-d|--data|--data-raw|--data-binary)\b.*https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(
			cmd,
		)
	) {
		warnings.push(
			"[interlinked] Warning: Sending data to an external URL. Verify this is intentional and not exfiltrating sensitive data.",
		);
	}
	if (/\b(env|printenv|set)\b.*\|\s*(curl|wget|nc|netcat)\b/i.test(cmd)) {
		return {
			warnings,
			block: {
				decision: "block",
				reason: "BLOCKED: Piping environment variables to a network tool is a data exfiltration risk.",
			},
			escalation: pendingEscalation,
		};
	}
	if (/\b(pip|npm)\s+install\b.*(-i\b|--index-url|--registry)\b/i.test(cmd)) {
		warnings.push(
			"[interlinked] Warning: Installing packages from a custom registry. Verify this is a trusted source (dependency confusion risk).",
		);
	}
	if (session) {
		const staged = detectDropperStaging(cmd, session.session_id);
		if (staged) {
			warnings.push(
				`[interlinked:supply-chain] Staging or executing a payload at ${staged} — this matches the dropper staging pattern used in supply chain attacks (ref: axios@1.14.1 wrote AppleScript to /tmp/ then executed via osascript). Prefer writing scripts to the project directory.`,
			);
		}
	}

	return { warnings, escalation: pendingEscalation };
}

/** Result of the Read sensitive-file / oversized-file block. */
export interface ReadGuardResult {
	warnings: string[];
	block?: HarnessDecision;
}

/** GUARD: Read — block sensitive files, warn on oversized files. Verbatim
 *  move of the inline `if (isReadOperation(...) && toolInput.file_path)`
 *  block; the caller has already confirmed those two conditions and passes
 *  the resolved `filePath`. Returns a block decision for sensitive files, or
 *  warnings for oversized reads. */
export function evaluateReadGuards(filePath: string): ReadGuardResult {
	const warnings: string[] = [];
	const readFileName = filePath.split("/").pop() || "";
	const sensitiveFilePatterns = [
		/^\.env($|\.)/,
		/^credentials\.json$/,
		/^service[_-]account.*\.json$/i,
		/\.pem$/,
		/\.key$/,
		/\.p12$/,
		/\.pfx$/,
		/\.jks$/,
	];
	const sensitiveExceptions = [/\.env\.example$/, /\.env\.sample$/, /\.env\.template$/];
	if (
		sensitiveFilePatterns.some((p) => p.test(readFileName)) &&
		!sensitiveExceptions.some((p) => p.test(readFileName))
	) {
		return {
			warnings,
			block: {
				decision: "block",
				reason: `BLOCKED: ${readFileName} contains secrets or credentials. Agents should not read sensitive files — use environment variables or ask the user for specific values you need.`,
			},
		};
	}
	try {
		if (existsSync(filePath)) {
			const stat = statSync(filePath);
			const sizeMB = stat.size / (1024 * 1024);
			if (sizeMB > LARGE_READ_SIZE_MB) {
				warnings.push(
					`[interlinked] Warning: ${filePath} is ${sizeMB.toFixed(1)}MB. Reading large files consumes significant context. Consider reading specific line ranges.`,
				);
			}
		}
	} catch (_err) {
		/* intentional: stat failure — let the tool handle the missing-file error */
	}
	return { warnings };
}

/** GUARD/GUIDE: curl-to-MCP detection + /mcp-route nudge. Verbatim move of
 *  the two inline `isBash` blocks that share the executed-span-scoped
 *  `mcpScanCommand`. Pure warnings (mutates `session.curl_localhost_count`,
 *  which is intentional — `session` is shared by reference). The caller
 *  passes the already-computed `mcpScanCommand` and `targetsMcpPath`. */
export function evaluateCurlMcpGuards(args: {
	mcpScanCommand: string;
	targetsMcpPath: boolean;
	curlMcpDetection: import("../types.js").GuardRulesConfig["curl_mcp_detection"];
	session: SessionTrajectory | undefined;
}): string[] {
	const { mcpScanCommand, targetsMcpPath, curlMcpDetection, session } = args;
	const warnings: string[] = [];

	if (curlMcpDetection.enabled && session && targetsMcpPath) {
		const cmd = mcpScanCommand;
		for (const port of curlMcpDetection.localhost_ports) {
			// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
			const pattern = new RegExp(
				`(?:curl|wget|fetch).*(?:localhost|127\\.0\\.0\\.1):${port}`,
				"i",
			);
			if (pattern.test(cmd)) {
				const count = (session.curl_localhost_count[port] || 0) + 1;
				session.curl_localhost_count[port] = count;
				if (count >= curlMcpDetection.escalate_after) {
					warnings.push(
						`[interlinked:curl-mcp] MCP server may be disconnected. ${count} curl calls to localhost:${port} detected this session. Consider reconnecting your MCP server.`,
					);
				} else {
					warnings.push(
						`[interlinked] ${curlMcpDetection.message} (${count}/${curlMcpDetection.escalate_after})`,
					);
				}
			}
		}
	}

	// GUARD: curl to /mcp routes — agent should use MCP directly. Same
	// executed-span scoping as the detection block above (mcpScanCommand), so
	// a commit message or heredoc that mentions `curl .../mcp` does not fire.
	{
		const cmd = mcpScanCommand;
		if (/\b(curl|wget|fetch)\b/.test(cmd) && /\/mcp\b/i.test(cmd)) {
			warnings.push(
				"[interlinked:mcp-direct] You're curling an /mcp endpoint directly. " +
					"MCP servers should be accessed via MCP tools, not HTTP. " +
					"If the MCP server isn't connected, ask the user to re-configure and restart it.",
			);
		}
	}

	return warnings;
}

/** GUIDE: Markdown-first curl/wget nudge. Verbatim move of the inline
 *  `if (isBash(toolName))` block that suggests `Accept: text/markdown`.
 *  Returns warnings to append (zero or one). */
export function evaluateMarkdownFirstCurlGuard(cmd: string): string[] {
	const warnings: string[] = [];
	if (
		/\b(curl|wget)\b/.test(cmd) &&
		// Public egress only — the Markdown-for-Agents edge is a public feature,
		// so loopback/tailnet/LAN health polls must not be nudged (2026-08-11).
		hasPublicHttpUrl(cmd) &&
		!/Accept:\s*text\/markdown/i.test(cmd) &&
		!/-H\s+["']Content-Type:\s*application\/json/i.test(cmd) &&
		!/-X\s+(POST|PUT|PATCH|DELETE)\b/i.test(cmd) &&
		!/--data\b|--data-raw\b|--data-binary\b|-d\s/i.test(cmd) &&
		!/\s-[oO]\s/.test(cmd)
	) {
		warnings.push(
			"[interlinked:markdown-first] curl/wget without Accept: text/markdown header. " +
				'Add: -H "Accept: text/markdown" to get Cloudflare\'s Markdown for Agents format (~80% fewer tokens). ' +
				"Response includes x-markdown-tokens header with estimated token count.",
		);
	}
	return warnings;
}
