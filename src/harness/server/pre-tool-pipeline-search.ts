// interlinked-tdd: exempt
// ===========================================
// PreToolUse search / grep-acceleration / tsgo phase helpers
// ===========================================
// Extracted verbatim from pre-tool-pipeline.ts to keep the orchestrator under
// the per-file line cap. Behaviour is byte-identical; these are leaf phase
// helpers. `isGrepIndexFresh` stays internal to this module.

import { execSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { checkGrepAcceleration, findRipgrep } from "../grep-accelerator.js";
import { parseGrepCommand } from "../regex-trigrams.js";
import { isBashTsc, tryTsgoRewrite } from "../server-tsgo-bash.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Search-tool classification + grep-substitution gating (no side effects). */
export interface SearchToolFlags {
	isSearchTool: boolean;
	ugrepAwareSearch: boolean;
	grepSubstitutionEnabled: boolean;
}

/**
 * Classify the event as a search tool and resolve whether grep substitution is
 * enabled. The index-status warning uses the classic rg/grep scope
 * (`isSearchTool`); substitution additionally recognizes native-build ugrep/ug,
 * but that path is gated on `grepSubstitutionEnabled` (off by default) — so with
 * substitution disabled, ugrep recognition has NO behavioral effect anywhere.
 */
export function classifySearchTool(event: HarnessEvent, rules: ServerRuntime["rules"]): SearchToolFlags {
	const isSearchTool =
		event.tool_name === "Grep" ||
		(event.tool_name === "Bash" &&
			/\b(rg|ripgrep|grep|egrep)\s/.test((event.tool_input?.command as string) || ""));
	const ugrepAwareSearch =
		isSearchTool ||
		(event.tool_name === "Bash" &&
			/\b(ugrep|ug|fgrep)\s/.test((event.tool_input?.command as string) || ""));
	const grepSubstitutionEnabled =
		process.env.INTERLINKED_GREP_ACCELERATOR === "1" ||
		(process.env.INTERLINKED_GREP_ACCELERATOR !== "0" &&
			rules.grep_acceleration?.substitution_enabled === true);
	return { isSearchTool, ugrepAwareSearch, grepSubstitutionEnabled };
}

/**
 * Never-worse-than-native completeness gate: the index provably reflects
 * current disk only when HEAD == baseCommit, the working tree is clean, and
 * there is no in-memory dirty layer. Fail-safe to false on any git error.
 */
function isGrepIndexFresh(ctx: ServerRuntime, searchIndex: NonNullable<ServerRuntime["trigramIndex"]>): boolean {
	const CWD = ctx.cwd;
	try {
		const head = execSync("git rev-parse HEAD", {
			cwd: CWD,
			encoding: "utf-8",
			timeout: 2000,
		}).trim();
		if (head && head === searchIndex.baseCommit && !searchIndex.isDirty) {
			const porcelain = execSync("git status --porcelain", {
				cwd: CWD,
				encoding: "utf-8",
				timeout: 5000,
			}).trim();
			return porcelain.length === 0;
		}
	} catch (e) {
		void e; // any git failure → treat as not-fresh → decline to native
	}
	return false;
}

/**
 * Grep acceleration: intercept search tools via the trigram index. The
 * substitution path (block-and-answer) is DISABLED by default; when enabled it
 * returns a replacement decision (merging guard warnings) or `null` to continue.
 * See the long-form note in the orchestrator history for why it is off.
 */
export function runGrepAcceleration(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
	flags: SearchToolFlags,
): HarnessDecision | null {
	const searchIndex = ctx.trigramIndex;
	if (
		!(
			preDecision.decision === "allow" &&
			searchIndex &&
			flags.ugrepAwareSearch &&
			flags.grepSubstitutionEnabled
		)
	) {
		return null;
	}
	// `indexFresh` is computed ONLY when substitution is enabled (off by
	// default), so the git cost is paid only by opt-in users — and amortized
	// against the large repos the size gate requires.
	const indexFresh = isGrepIndexFresh(ctx, searchIndex);
	const grepDecision = checkGrepAcceleration(event, searchIndex, { indexFresh }, ctx.fileContentCache);
	if (grepDecision) {
		ctx.log(`Grep accelerated: ${event.tool_name} → ${grepDecision.decision}`);
		// Merge any warnings from the guard evaluation
		if (preDecision.warnings?.length) {
			grepDecision.warnings = [
				...preDecision.warnings,
				...(grepDecision.warnings || []),
			];
		}
		return grepDecision;
	}
	return null;
}

/** True when a search path resolves inside the project represented by the index. */
function isIndexedPath(cwd: string, searchPath: string | undefined): boolean {
	if (!searchPath || searchPath === ".") return true;
	if (searchPath === "~" || searchPath.startsWith("~/")) return false;
	const rel = relative(cwd, resolve(cwd, searchPath));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The status warning is only relevant when the accelerator could own this
 * invocation. Compound/unsupported Bash commands and searches rooted outside
 * the indexed project always belong to native search.
 */
function isIndexApplicableSearch(ctx: ServerRuntime, event: HarnessEvent): boolean {
	if (event.tool_name === "Grep") {
		const input = event.tool_input || {};
		return (
			Boolean(input.pattern) &&
			!input.glob &&
			!input.output_mode &&
			isIndexedPath(ctx.cwd, input.path as string | undefined)
		);
	}
	if (event.tool_name === "Bash") {
		const parsed = parseGrepCommand((event.tool_input?.command as string) || "");
		return Boolean(parsed && isIndexedPath(ctx.cwd, parsed.path));
	}
	return false;
}

/**
 * For searches where index substitution is active and an index is loaded, add
 * actionable index-health status as a warning. A missing index is a supported
 * fail-open state: native search still works, so do not nudge agents to build
 * an index that may have been deliberately removed.
 *
 * Once-per-session dedup: this fired on every search call before, training
 * agents to ignore it. The status doesn't change mid-session (trigramIndex is
 * loaded once at startup), so re-emitting buys nothing.
 */
export function emitIndexStatusWarning(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
	flags: SearchToolFlags,
): void {
	const CWD = ctx.cwd;
	const indexWarnKey = event.session_id || "anonymous";
	const searchIndex = ctx.trigramIndex;
	if (
		!(
			flags.isSearchTool &&
			flags.grepSubstitutionEnabled &&
			searchIndex &&
			isIndexApplicableSearch(ctx, event) &&
			preDecision.decision === "allow" &&
			!ctx.indexWarningSent.has(indexWarnKey)
		)
	) {
		return;
	}
	const warnings = preDecision.warnings || [];
	let emitted = false;
	if (!findRipgrep()) {
		warnings.push(
			"[interlinked:index] Index loaded but ripgrep not installed — grep acceleration disabled. Install: brew install ripgrep",
		);
		emitted = true;
	} else {
		// Index + rg both available. Check freshness by comparing base commit to HEAD.
		try {
			const head = execSync("git rev-parse HEAD", {
				cwd: CWD,
				encoding: "utf-8",
				timeout: 2000,
			}).trim();
			if (head && searchIndex.baseCommit && head !== searchIndex.baseCommit) {
				const behindCount = execSync(
					`git rev-list --count ${searchIndex.baseCommit.slice(0, 8)}..HEAD`,
					{ cwd: CWD, encoding: "utf-8", timeout: 2000 },
				).trim();
				warnings.push(
					`[interlinked:index] Search index is ${behindCount} commit(s) behind HEAD. Run \`interlinked index build\` to refresh.`,
				);
				emitted = true;
			}
		} catch (e) {
			void e;
		}
	}
	// Mark sent regardless of whether we emitted — clean state need not re-check.
	ctx.indexWarningSent.add(indexWarnKey);
	if (emitted) {
		preDecision.warnings = warnings;
	}
}

/**
 * tsgo acceleration: rewrite `tsc` → `tsgo` when available. Returns the
 * rewritten decision, or `null` after annotating a warning when tsgo is absent.
 */
export function runTsgoAcceleration(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): HarnessDecision | null {
	if (preDecision.decision === "allow" && isBashTsc(event)) {
		const tsgoResult = tryTsgoRewrite(event, ctx.cwd, ctx.log);
		if (tsgoResult) return tsgoResult;
		// tsgo not available — let tsc through but note it in warnings
		const warnings = preDecision.warnings || [];
		warnings.push(
			"[interlinked:tsc] Using tsc (tsgo not available — install @typescript/native-preview for ~10x faster type checking)",
		);
		preDecision.warnings = warnings;
	}
	return null;
}
