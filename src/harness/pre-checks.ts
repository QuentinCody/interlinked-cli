// ===========================================
// Pre-Checks — Additional PreToolUse safety checks
// ===========================================
// Pure functions called from evaluatePreToolUse(). Each returns
// { block, warning } or null if not applicable.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { countCodeLines, isCappableFile, maxLinesFor } from "./large-file-policy.js";
import { projectLineCount } from "./line-count-projection.js";
import type { SessionTrajectory } from "./types.js";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** Recency threshold: only warn about concurrent writes within the last 10 minutes. */
const CONCURRENT_EDIT_WINDOW_MS = 10 * SECONDS_PER_MINUTE * MS_PER_SECOND;

// ===========================================
// Protected PIDs — never allow killing these
// ===========================================

/** Collect PIDs that must never be killed: self, parent, harness, and ancestor chain. */
function getProtectedPids(): Set<number> {
	const pids = new Set<number>();

	// Current process (harness server)
	pids.add(process.pid);

	// Parent process (likely the shell or Claude Code node process)
	if (process.ppid) pids.add(process.ppid);

	// Walk up the parent chain to protect the entire Claude Code process tree.
	// Use a single ps call to get the full ancestor chain efficiently.
	try {
		const output = execSync("ps -o pid=,ppid= -ax 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		const pidToParent = new Map<number, number>();
		for (const line of output.split("\n")) {
			const match = line.trim().match(/^(\d+)\s+(\d+)$/);
			if (match) {
				pidToParent.set(Number.parseInt(nonNull(match[1]), 10), Number.parseInt(nonNull(match[2]), 10));
			}
		}
		// Walk ancestors from our ppid
		let current = process.ppid;
		for (let i = 0; i < 10 && current > 1; i++) {
			pids.add(current);
			const parent = pidToParent.get(current);
			if (!parent || parent <= 1) break;
			current = parent;
		}
	} catch (e) {
		void e;
	}

	// Read harness PID file if it exists
	try {
		const pidFile = join(process.cwd(), ".interlinked", "harness.pid");
		if (existsSync(pidFile)) {
			const harnessPid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (!Number.isNaN(harnessPid)) pids.add(harnessPid);
		}
	} catch (e) {
		void e;
	}

	return pids;
}

// Cache protected PIDs (refreshed once per process lifetime — PIDs don't change)
let _protectedPids: Set<number> | null = null;
function protectedPids(): Set<number> {
	if (!_protectedPids) _protectedPids = getProtectedPids();
	return _protectedPids;
}

interface PreCheckResult {
	block?: string;
	warning?: string;
}

// ===========================================
// Check 0: Self-kill protection
// ===========================================
// Blocks `kill <PID>` when the PID is the harness, Claude Code, or any
// ancestor process in the session's process tree.

export function checkSelfKill(command: string): PreCheckResult | null {
	// Match "kill <PID>" (plain kill with a single numeric PID)
	const killMatch = command.match(/^\s*kill\s+(\d+)\s*$/);
	if (!killMatch) return null;

	const targetPid = Number.parseInt(nonNull(killMatch[1]), 10);
	if (Number.isNaN(targetPid)) return null;

	// Check 1: Is it in our known protected set (harness + ancestors)?
	const protected_ = protectedPids();
	if (protected_.has(targetPid)) {
		return {
			block: `PID ${targetPid} is the harness or an ancestor of the current session — killing it would terminate this session. Use a different approach to manage this process.`,
		};
	}

	// Check 2: Resolve the target PID's command. If it looks like a Claude
	// Code session OR a *non-orphan* interlinked harness, warn — these kills
	// might disrupt an active session in another shell. Orphan harness daemons
	// (no living parent except init=1) are explicitly allowed because Check 1
	// already protects the ones that matter (this session's harness + the
	// process tree's ancestors), and orphan reaping is a legitimate
	// maintenance operation we WANT to support without friction. The over-
	// broad earlier rule (`block` on any node+interlinked process) made
	// orphan cleanup impossible — see `commands/harness.ts:reapOrphanHarnesses`
	// which depends on this check NOT firing on stale daemons.
	try {
		const info = execSync(`ps -o ppid=,comm=,args= -p ${targetPid} 2>/dev/null`, {
			encoding: "utf-8",
			timeout: 1000,
		}).trim();
		const ppidMatch = info.match(/^\s*(\d+)\s/);
		const targetPpid = ppidMatch ? Number.parseInt(nonNull(ppidMatch[1]), 10) : 0;
		const lower = info.toLowerCase();
		const isClaudeOrInterlinked =
			(lower.includes("node") || lower.includes("bun") || lower.includes("deno")) &&
			(lower.includes("claude") ||
				lower.includes("interlinked") ||
				lower.includes("harness/server"));
		// Treat ppid==1 (or 0) as orphan — its parent shell exited; this is
		// a stale daemon, not a live session. Allow the kill silently.
		const isOrphan = targetPpid <= 1;
		if (isClaudeOrInterlinked && !isOrphan) {
			return {
				warning: `PID ${targetPid} appears to be a live Claude Code or Interlinked process in another session (${info.slice(0, 80).trim()}). Killing it will terminate that session — proceed only if intended.`,
			};
		}
	} catch (e) {
		void e;
	}

	return null;
}

// ===========================================
// Check 1: .env leak to git
// ===========================================
// Fires on Write/Edit to .env* files. Blocks if file is not gitignored
// and content contains secret-like patterns.

export function checkEnvLeakToGit(
	filePath: string,
	content: string | undefined,
	cwd: string,
): PreCheckResult | null {
	const base = basename(filePath);

	// Only check .env-like files
	if (!base.startsWith(".env") && !base.endsWith(".env")) return null;
	// Allow .env.example and .env.sample
	if (base.includes("example") || base.includes("sample") || base.includes("template")) {
		return null;
	}

	// Check if file is gitignored
	const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	try {
		execSync(`git check-ignore --quiet "${absPath}"`, {
			cwd,
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Exit 0 = file IS gitignored, safe
		return null;
	} catch (e) {
		void e;
	}

	// Check if content looks like it has secrets
	const text = content || "";
	const hasSecrets =
		/(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|AWS_|DATABASE_URL)\s*=\s*\S+/i.test(text);

	if (hasSecrets) {
		return {
			block: `Writing secrets to ${base} which is NOT in .gitignore — add it to .gitignore first, or use ${base}.example with placeholder values`,
		};
	}

	return {
		warning: `[interlinked:env-leak] ${base} is not in .gitignore — secrets in this file could be committed to version control`,
	};
}

// ===========================================
// Check 2: Stale branch detection
// ===========================================
// Warns if agent's branch is significantly behind main.
// Cached: only runs once per 5 minutes per session.

const staleBranchCache = new Map<string, { ts: number; result: PreCheckResult | null }>();
const STALE_BRANCH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_BRANCH_THRESHOLD = 50;

export function checkStaleBranch(cwd: string, sessionId: string): PreCheckResult | null {
	const cacheKey = `${sessionId}:${cwd}`;
	const cached = staleBranchCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < STALE_BRANCH_INTERVAL_MS) {
		return cached.result;
	}

	// Quick check: skip if not in a git repo (avoids slow subprocess for non-git dirs)
	if (!existsSync(join(cwd, ".git"))) {
		staleBranchCache.set(cacheKey, { ts: Date.now(), result: null });
		return null;
	}

	let result: PreCheckResult | null = null;
	try {
		// Determine main branch name
		const mainBranch = execSync(
			"git rev-parse --verify main 2>/dev/null && echo main || echo master",
			{
				cwd,
				timeout: 2000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		).trim();

		// Count commits behind
		const behindStr = execSync(`git rev-list --count HEAD..${mainBranch} 2>/dev/null`, {
			cwd,
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		const behind = Number.parseInt(behindStr, 10);
		if (!Number.isNaN(behind) && behind > STALE_BRANCH_THRESHOLD) {
			result = {
				warning: `[interlinked:stale-branch] Current branch is ${behind} commits behind ${mainBranch} — consider rebasing or merging`,
			};
		}
	} catch (e) {
		void e;
	}

	staleBranchCache.set(cacheKey, { ts: Date.now(), result });
	return result;
}

// ===========================================
// Check 3: Dirty working tree guard
// ===========================================
// Warns when about to run git checkout/switch/rebase with uncommitted changes.

export function checkDirtyWorkingTree(command: string, cwd: string): PreCheckResult | null {
	// Only check git commands that could discard changes
	if (!/\bgit\s+(checkout|switch|rebase|reset)\b/.test(command)) return null;

	try {
		const status = execSync("git status --porcelain 2>/dev/null", {
			cwd,
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		if (status.length > 0) {
			const changedCount = status.split("\n").length;
			return {
				warning: `[interlinked:dirty-worktree] ${changedCount} uncommitted change(s) — running this git command may discard work. Consider stashing first.`,
			};
		}
	} catch (e) {
		void e;
	}

	return null;
}

// ===========================================
// Check 4: Large file write prevention
// ===========================================
// Warns when about to write a file >50KB (likely generated/minified).

const LARGE_FILE_THRESHOLD = 50 * 1024; // 50KB

export function checkLargeFileWrite(content: string | undefined): PreCheckResult | null {
	if (!content) return null;

	const size = Buffer.byteLength(content, "utf-8");
	if (size > LARGE_FILE_THRESHOLD) {
		const sizeKB = Math.round(size / 1024);
		return {
			warning: `[interlinked:large-file] About to write ${sizeKB}KB — files this large are often generated or minified. Consider splitting into smaller modules.`,
		};
	}

	return null;
}

// ===========================================
// Check 5: Concurrent edit detection
// ===========================================
// Warns when another session has recently written to the same file.

export function checkConcurrentEdit(
	filePath: string,
	currentSessionId: string,
	allSessions: SessionTrajectory[],
): PreCheckResult | null {
	const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

	for (const session of allSessions) {
		if (session.session_id === currentSessionId) continue;
		if (!session.files_written.has(absPath)) continue;

		const writeTimeStr = session.file_write_times.get(absPath);
		if (!writeTimeStr) continue;

		// Only warn about recent writes (last 10 minutes)
		const writeTimeMs = new Date(writeTimeStr).getTime();
		if (Number.isNaN(writeTimeMs)) continue;
		const ageMs = Date.now() - writeTimeMs;
		if (ageMs > CONCURRENT_EDIT_WINDOW_MS) continue;

		const ageSec = Math.round(ageMs / MS_PER_SECOND);
		const otherAgent = session.agent_name || session.session_id.slice(0, 8);
		return {
			warning: `[interlinked:concurrent-edit] "${otherAgent}" wrote to this file ${ageSec}s ago — coordinate to avoid conflicts`,
		};
	}

	return null;
}

// ===========================================
// Check: Bash-routed code-file writes
// ===========================================
// Extracted to ./pre-checks-bash-write-detect.ts (leaf cluster of pure shell
// parsers, no shared module state). Re-exported here so existing importers
// keep resolving `detectBashCodeFileWrite` from this module unchanged.
export {
	detectBashCodeFileWrite,
	resolveBashWriteTarget,
} from "./pre-checks-bash-write-detect.js";

// ===========================================
// Check 6: Large-file line-count cap (ratchet)
// ===========================================
// Blocks a Write/Edit that would push a hand-written code file PAST the
// per-file line cap, or grow a file that is ALREADY past it. Edits that
// hold or shrink an over-cap file are always allowed (so an oversized file
// can be refactored down), and so is comment-only growth (docs, not code).
// Generated, test, .d.ts and non-code files are exempt (see
// large-file-policy.ts). The Write/Edit/MultiEdit projection lives in
// line-count-projection.ts. Fail-open on any uncertainty (an unreadable
// file, an unprojectable tool shape) — a size cap must never wedge an
// agent mid-task.

/**
 * The PreToolUse half of the per-file line cap. Returns a `block` when a
 * Write/Edit would grow a cappable file past the cap; null otherwise. The
 * decision is a pure before/after delta against live file state — no
 * baseline lookup — so a grandfathered file is naturally allowed to shrink
 * or hold but not grow.
 */
export function checkLargeFileLineCountWrite(
	toolInput: JsonObject,
	cwd: string,
): PreCheckResult | null {
	const filePath =
		(typeof toolInput.file_path === "string" && toolInput.file_path) ||
		(typeof toolInput.path === "string" && toolInput.path) ||
		"";
	if (!filePath) return null;

	const projection = projectLineCount(toolInput, filePath);
	if (!projection) return null;
	const { before, after, content } = projection;

	if (!isCappableFile({ filePath, content, root: cwd })) return null;

	const cap = maxLinesFor(cwd);
	if (after <= cap) return null; // result is within the cap
	if (after <= before) return null; // not growing — refactoring down is always allowed

	// Comment-only growth (field report 2026-07-06): an edit whose net added
	// lines are entirely comments/blank grows the RAW count but not the CODE
	// count — documentation, not code growth — and is always allowed, even on
	// an over-cap or grandfathered file. DELIBERATE grandfather interaction:
	// the recorded ceiling in large-files-baseline.json keeps tracking RAW
	// lines and is NOT raised by this allowance (ceilings may only shrink —
	// the baseline-integrity gate enforces that), so sustained comment growth
	// past a recorded ceiling surfaces in verify's large_files check instead.
	// See large-file-policy.ts::countCodeLines.
	if (
		projection.afterText !== null &&
		countCodeLines(projection.afterText) <= countCodeLines(projection.beforeText)
	) {
		return null;
	}

	const action = before === 0 ? `create ${filePath} at` : `grow ${filePath} to`;
	const alreadyOver =
		before > cap
			? `It is already ${before} lines; edits to it may hold or shrink it, not grow it. `
			: "";
	return {
		block:
			`[interlinked:file-size] BLOCKED: this would ${action} ${after} lines — ` +
			`${after - cap} over the ${cap}-line cap for hand-written code files. ${alreadyOver}` +
			"Extract a cohesive section into its own module first. This line cap is per-repo " +
			"configurable: `interlinked caps set lines <n>` (`caps explain lines` for why); " +
			"generated, test, .d.ts, and non-code files (docs/markdown/HTML/data) are exempt. " +
			"List: large-files-baseline.json.",
	};
}
