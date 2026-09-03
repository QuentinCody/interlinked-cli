// ===========================================
// Cursor adapter
// ===========================================
// Cursor hook events (per https://cursor.com/docs/hooks, as of 2026-04):
//   sessionStart, sessionEnd, stop, preCompact,
//   beforeSubmitPrompt,
//   preToolUse, postToolUse, postToolUseFailure,
//   subagentStart, subagentStop,
//   beforeShellExecution, afterShellExecution,
//   beforeMCPExecution (also seen as beforeMcpToolExecution / afterMcpToolExecution
//   in some builds — kept as defence-in-depth aliases), afterMCPExecution,
//   beforeReadFile, afterFileEdit
//
// Payload shape varies per event — adapter is tolerant of unknown fields.
//
// Response field names are SNAKE_CASE (per Cursor docs):
//   { permission: "allow"|"deny"|"ask",
//     user_message?, agent_message?, updated_input?,
//     additional_context?, updated_mcp_tool_output?, followup_message? }
//
// Per-event capability map (the docs differ by event):
//   - beforeShellExecution / beforeMCPExecution: allow|deny|ask + user/agent_message
//   - preToolUse: allow|deny only (ask accepted by schema, not enforced)
//   - beforeReadFile: allow|deny + user_message
//   - subagentStart: allow|deny + user_message (ask treated as deny)
//   - postToolUse: additional_context (model-visible PostToolUse channel —
//                  this is the parity hook with Claude Code's additionalContext)
//   - subagentStop: followup_message (auto-continue prompt)
//   - preCompact: user_message (observation only)
//   - postToolUseFailure / afterFileEdit / afterShellExecution / afterMCPExecution:
//                  no enforced output; we surface reasons via stderr (human-only)
//
// Cursor SUPPORTS "ask" as a first-class primitive on the shell/MCP gates —
// when our harness returns `decision: "ask"`, we map to `permission: "ask"`
// so the user sees an interactive prompt rather than a blanket deny. On
// gates that don't enforce ask (preToolUse / beforeReadFile / subagentStart),
// we collapse to `permission: "deny"` so the user still sees the reason and
// can refine.

import type { JsonObject } from "../../lib/json-types.js";
import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import type { ClassifierOverrides } from "../tool-class-classifier.js";
import { adapterToolClassifier } from "./adapter-tool-class.js";
import { buildCursorAction } from "./cursor-actions.js";
import { buildHookCommand } from "./hook-command.js";
import { normalizeNativeHookEvent } from "./normalization.js";
import { CURSOR_CAPABILITIES, installedEventNames } from "./provider-capabilities.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

/** Missing-runtime policy per NATIVE event (review 2026-08-28 P0), derived
 *  from GATED_EVENTS below — the ONE definition of "this event is an
 *  allow/deny gate". A second hand-written list here silently disagreed with
 *  it on `subagentStart` (second-pass review finding 2) — exactly the
 *  duplicated-policy drift this module's own comments warn about. Gated ⇒ the
 *  missing-binary fallback fails closed (exit 2); everything else stays
 *  warn-open (blocking Stop risks a stop-hook loop, and a post-hook block
 *  cannot un-run the tool). */
function cursorMissingRuntimePolicy(event: string): "fail_closed" | "warn_open" {
	return GATED_EVENTS.has(event) ? "fail_closed" : "warn_open";
}

const NATIVE_EVENTS = installedEventNames(CURSOR_CAPABILITIES);

// Events that are gated (we can return permission: allow|deny). These are
// `failClosed: true` in the settings fragment.
const GATED_EVENTS = new Set<string>([
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeMcpToolExecution",
	"beforeReadFile",
	"preToolUse",
	"subagentStart",
]);

// Subset of GATED_EVENTS where Cursor actually honors `permission: "ask"`.
// Per Cursor docs (2026-04): the schema accepts ask everywhere but only
// shell/MCP gates enforce it. preToolUse, beforeReadFile, subagentStart
// silently degrade — we collapse `decision: "ask"` to deny on those so the
// user still sees the reason instead of the action proceeding unguarded.
const ASK_CAPABLE_EVENTS = new Set<string>([
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeMcpToolExecution",
]);

// Post-tool events whose output supports `additional_context` — model-visible
// feedback channel (Cursor's analogue of Claude's `additionalContext`). Only
// the generic `postToolUse` carries it per the docs; specific after* hooks
// are observation-only.
const POST_CONTEXT_EVENTS = new Set<string>(["postToolUse"]);

interface CursorAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createCursorAdapter(opts: CursorAdapterOptions = {}): RunnerAdapter {
	return {
		id: "cursor",
		label: "Cursor",
		capabilities: CURSOR_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(env.CURSOR_SESSION_ID || env.CURSOR_TRACE_ID || env.CURSOR_API_URL);
		},

		parseHookInput(nativeJson, nativeEventName) {
			return normalizeNativeHookEvent({
				runner: "cursor",
				capabilities: CURSOR_CAPABILITIES,
				nativeEventName,
				nativeJson,
				aliases: { cwd: ["cwd", "workspace_root"] },
				buildAction: ({ raw }) => buildCursorAction(nativeEventName, raw, opts.overrides),
			});
		},

		classifyToolClass: adapterToolClassifier(opts.overrides),

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			// Cursor's hook config file is `hooks.json` (not `settings.json`);
			// per docs the file is searched at `~/.cursor/hooks.json` (user)
			// or `<project>/.cursor/hooks.json` (project).
			const path = scope === "user" ? "~/.cursor/hooks.json" : ".cursor/hooks.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				const hookCommand = buildHookCommand(binaryPath, "cursor", event, cursorMissingRuntimePolicy(event));
				const entry: JsonObject = { command: hookCommand, type: "command" };
				if (GATED_EVENTS.has(event)) {
					entry.failClosed = true;
				}
				hooks[event] = [entry];
			}
			return { path, fragment: { version: 1, hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision(decision, event): AdapterOutput {
			return encodeCursorDecision(decision, event.runner_native_event);
		},
	};
}

// ---------------------------------------------------------------------------
// Decision encoding — split out so the registry's `encodeDecision` is one
// line. Each decision branch has its own helper so the cold reader can scan
// "block / ask / allow" without holding the entire dispatch in their head.
// ---------------------------------------------------------------------------

const BLOCK_DECISION = "block";
const ASK_DECISION = "ask";
const DEFAULT_BLOCK_REASON =
	"Blocked by the interlinked harness, but no reason was attached — likely a harness bug; " +
	"re-run, or run `interlinked harness restart`, then report it.";
const DEFAULT_ASK_REASON = "Confirmation required";

function encodeCursorDecision(
	decision: import("../types.js").HarnessDecision,
	nativeEvent: string,
): AdapterOutput {
	const stderr = joinWarnings(decision.warnings);
	const isGated = GATED_EVENTS.has(nativeEvent);
	const askCapable = ASK_CAPABLE_EVENTS.has(nativeEvent);
	const postContextCapable = POST_CONTEXT_EVENTS.has(nativeEvent);

	if (decision.decision === BLOCK_DECISION) {
		return encodeCursorBlock(decision, { isGated, postContextCapable, stderr });
	}
	if (decision.decision === ASK_DECISION) {
		return encodeCursorAsk(decision, { isGated, askCapable, stderr });
	}
	return encodeCursorAllow(decision, { isGated, postContextCapable, stderr });
}

interface EncodeContext {
	isGated: boolean;
	askCapable?: boolean;
	postContextCapable?: boolean;
	stderr: string;
}

// `decision: "block"` — render as deny on a pre gate; route advisory feedback
// through `additional_context` on `postToolUse`; everything else falls
// through to stderr (human-only, model-blind).
function encodeCursorBlock(
	decision: import("../types.js").HarnessDecision,
	ctx: EncodeContext,
): AdapterOutput {
	if (ctx.isGated) {
		const reason = decision.reason ?? DEFAULT_BLOCK_REASON;
		return jsonOut(
			{ permission: "deny", agent_message: reason, user_message: reason },
			ctx.stderr,
		);
	}
	if (ctx.postContextCapable && decision.reason) {
		// Cursor's postToolUse can't roll back an executed tool, but
		// `additional_context` is the model-visible feedback channel —
		// same idea as Claude's PostToolUse `additionalContext`.
		return jsonOut({ additional_context: decision.reason }, ctx.stderr);
	}
	return stderrOut(decision.reason || ctx.stderr || undefined);
}

// `decision: "ask"` — only honored on shell + MCP gates per Cursor docs;
// elsewhere we collapse to deny so the user still sees the reason.
function encodeCursorAsk(
	decision: import("../types.js").HarnessDecision,
	ctx: EncodeContext,
): AdapterOutput {
	// Pre-append resolved targets to BOTH the agent-facing `reason` and the
	// user-facing message so the human sees the concrete file/URL/branch in
	// the prompt body. On the deny-fallback path (preToolUse / beforeReadFile
	// / subagentStart) the same enriched reason still surfaces — the user
	// hits a deny dialog with the targets attached.
	const baseReason = decision.reason ?? DEFAULT_ASK_REASON;
	const reasonWithTargets = formatAskReasonWithTargets(baseReason, decision.resolved_targets);
	const baseUserMsg = decision.system_message || decision.reason || DEFAULT_ASK_REASON;
	const userMsgWithTargets = formatAskReasonWithTargets(baseUserMsg, decision.resolved_targets);

	if (!ctx.isGated) {
		return stderrOut(reasonWithTargets || ctx.stderr || undefined);
	}
	if (ctx.askCapable) {
		return jsonOut(
			{
				permission: ASK_DECISION,
				agent_message: reasonWithTargets,
				user_message: userMsgWithTargets,
			},
			ctx.stderr,
		);
	}
	// Gated but ask-incapable (preToolUse / beforeReadFile / subagentStart).
	// Per docs Cursor accepts `ask` in the schema but does NOT enforce it on
	// these events — silently treats it as allow on preToolUse, deny on
	// subagentStart. Collapsing to deny is the safer and more consistent UX.
	return jsonOut(
		{
			permission: "deny",
			agent_message: reasonWithTargets,
			user_message: userMsgWithTargets,
		},
		ctx.stderr,
	);
}

// `decision: "allow"` — emit `permission: "allow"` on pre gates so Cursor
// proceeds; on `postToolUse` use `additional_context` for advisory model
// signal (parity with Claude's PostToolUse additionalContext channel).
function encodeCursorAllow(
	decision: import("../types.js").HarnessDecision,
	ctx: EncodeContext,
): AdapterOutput {
	if (ctx.postContextCapable && decision.additional_context) {
		return jsonOut({ additional_context: decision.additional_context }, ctx.stderr);
	}
	if (!ctx.isGated) {
		return stderrOut(ctx.stderr || undefined);
	}
	const payload: JsonObject = { permission: "allow" };
	if (decision.additional_context) {
		// Pre-event: Cursor doesn't have an additionalContext channel on
		// allow, but `agent_message` is a documented field. Use it as a
		// best-effort surface for non-blocking advisory text.
		payload.agent_message = decision.additional_context;
	}
	return jsonOut(payload, ctx.stderr);
}

function jsonOut(payload: JsonObject, stderr: string): AdapterOutput {
	return {
		stdout: JSON.stringify(payload),
		stderr: stderr || undefined,
		exit_code: 0,
	};
}

function stderrOut(stderr: string | undefined): AdapterOutput {
	return { stdout: undefined, stderr, exit_code: 0 };
}

function joinWarnings(warnings: string[] | undefined): string {
	return (warnings ?? []).join("\n");
}
