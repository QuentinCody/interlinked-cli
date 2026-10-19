// ===========================================
// Touch attribution — which observed effects this call could have made
// ===========================================
//
// The workspace ChangeSet (`workspace-effects.ts`) is a whole-workspace
// snapshot diff over the window one tool call occupied. On a shared tree it
// also contains every sibling actor's write that landed in that window, and
// files-touched.jsonl used to charge all of them to the caller: 1,703 of
// 16,185 rows (10.5%, 30 days to 2026-10-08, E26) repeated another actor's
// identical change. This module labels each observed effect.
//
// ATTRIBUTION RULE (one label per effect; first matching line wins):
//   1. Read-only tool (`lib/hook-read-only-tools.ts`) -> shadow `read-only-tool`.
//   2. Direct-edit tool (Write / Edit / MultiEdit / NotebookEdit / apply_patch,
//      `lib/write-tool-registry.ts`) with parseable targets: the effect is
//      `declared-target` when its path is one of the tool's own targets
//      (file_path / notebook_path / every apply_patch section path, both sides
//      of a move), else shadow `not-declared-target`. With NO parseable target
//      the call falls through to rule 3 rather than disowning everything.
//   3. Any other tool (Bash, MCP, unknown) — `observed-in-window` unless:
//      a. another actor has an in-flight call that declared this path as its
//         target -> shadow `in-flight-target-of-other-actor`;
//      b. another actor was already attributed the identical change (same
//         path, before sha256, after sha256) within TOUCH_DEDUPE_WINDOW_MS
//         (10 min) -> shadow `attributed-to-other-actor` — the dedupe rule of
//         scratch/2026-10-08-decisions-orthogonal/e26-conflict/build.py
//         `mark_shadows`;
//      c. the file still exists and max(mtime, ctime) is earlier than the
//         call's before-snapshot -> shadow `changed-before-call` (ctime is
//         used too because `cp -p` / `tar x` restore an old mtime).
//
// Shadow rows are KEPT and marked (`attribution: "shadow"`, `shadow_reason`):
// they still prove the workspace changed during the call, which a reader of
// files-touched may need. Only attributed effects feed the recent-touch ring
// (so a shadow can never shadow a later caller) and the cross-actor residue
// registry (`workspace-effect-attribution.ts`).
//
// Limits: the ring is in-memory (a daemon restart forgets the last 10 min);
// two Bash calls racing on one path are attributed to whichever reconciles
// first. Gate inputs (`event.change_set`) are unchanged; this only labels.

import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isReadOnlyToolName } from "../lib/hook-read-only-tools.js";
import { isDirectFileEditTool } from "../lib/write-tool-registry.js";
import { extractAllEditedFilePaths } from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

export const TOUCH_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const RECENT_TOUCH_CEILING = 4096;
/** Clock-rounding tolerance between Date (ms) and filesystem timestamps. */
const WINDOW_SLACK_MS = 1;

export type TouchAttribution = "declared-target" | "observed-in-window" | "shadow";
export type TouchShadowReason =
	| "read-only-tool"
	| "not-declared-target"
	| "in-flight-target-of-other-actor"
	| "attributed-to-other-actor"
	| "changed-before-call";

export interface TouchAttributionFields {
	attribution?: TouchAttribution;
	shadow_reason?: TouchShadowReason;
}

interface AttributableEffect extends TouchAttributionFields {
	path: string;
	kind: "created" | "modified" | "deleted";
	before_sha256: string | null;
	after_sha256: string | null;
}

export interface AttributionInput<E extends AttributableEffect> {
	root: string;
	actorKey: string;
	toolName: string | undefined;
	/** Root-relative or absolute target paths the call declared. */
	declaredTargets: readonly string[];
	beforeCapturedAt: string;
	/** Root-relative targets of OTHER actors' calls still in flight. */
	inFlightTargetsOfOthers: ReadonlySet<string>;
	effects: readonly E[];
	nowMs: number;
}

const recentTouches = new Map<string, { actorKey: string; atMs: number }>();

/** One actor = one session thread (root, or one subagent). */
export function touchActorKey(sessionId: string, subagentId?: string | null): string {
	return `${sessionId}\0${subagentId || ""}`;
}

/** Normalize a declared path to the root-relative form snapshot paths use. */
export function toRootRelative(root: string, path: string): string {
	return relative(root, isAbsolute(path) ? resolve(path) : resolve(root, path));
}

const PATCH_SECTION_LINE = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s+(.+)$/gm;

function patchSectionPaths(toolInput: HarnessEvent["tool_input"]): string[] {
	const raw = toolInput?.command ?? toolInput?.patch ?? toolInput?.content ?? toolInput?._raw_patch;
	if (typeof raw !== "string") return [];
	return [...raw.matchAll(PATCH_SECTION_LINE)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}

/** Target paths the call itself declared (root-relative). Shell and unknown
 *  tools declare none: their effects are judged by the window rule. */
export function declaredTouchTargets(event: HarnessEvent, root: string): string[] {
	if (!isDirectFileEditTool(event.tool_name)) return [];
	// Declared intent only: never the observed ChangeSet, which is the thing
	// being attributed.
	const { change_set: _observed, ...declared } = event;
	void _observed;
	const paths = [...extractAllEditedFilePaths(declared), ...patchSectionPaths(event.tool_input)];
	const notebook = event.tool_input?.notebook_path;
	if (typeof notebook === "string" && notebook.length > 0) paths.push(notebook);
	return [...new Set(paths.map((p) => toRootRelative(root, p)))];
}

function touchKey(effect: AttributableEffect): string {
	return `${effect.path}\0${effect.before_sha256 ?? ""}\0${effect.after_sha256 ?? ""}`;
}

function attributedToOther(effect: AttributableEffect, actorKey: string, nowMs: number): boolean {
	const prior = recentTouches.get(touchKey(effect));
	return prior !== undefined && prior.actorKey !== actorKey && nowMs - prior.atMs <= TOUCH_DEDUPE_WINDOW_MS;
}

function changedBeforeCall(root: string, effect: AttributableEffect, beforeMs: number): boolean {
	if (effect.kind === "deleted" || !Number.isFinite(beforeMs)) return false;
	try {
		const stat = lstatSync(resolve(root, effect.path));
		return Math.max(stat.mtimeMs, stat.ctimeMs) < beforeMs - WINDOW_SLACK_MS;
	} catch {
		return false; // vanished since the snapshot: no evidence either way
	}
}

function windowLabel<E extends AttributableEffect>(input: AttributionInput<E>, effect: E): TouchAttributionFields {
	if (input.inFlightTargetsOfOthers.has(effect.path)) return { attribution: "shadow", shadow_reason: "in-flight-target-of-other-actor" };
	if (attributedToOther(effect, input.actorKey, input.nowMs)) return { attribution: "shadow", shadow_reason: "attributed-to-other-actor" };
	if (changedBeforeCall(input.root, effect, Date.parse(input.beforeCapturedAt))) return { attribution: "shadow", shadow_reason: "changed-before-call" };
	return { attribution: "observed-in-window" };
}

/** Label every observed effect per the module's attribution rule. */
export function attributeWorkspaceEffects<E extends AttributableEffect>(input: AttributionInput<E>): Array<E & TouchAttributionFields> {
	const readOnly = isReadOnlyToolName(input.toolName);
	const targets = new Set(input.declaredTargets.map((p) => toRootRelative(input.root, p)));
	const byTarget = isDirectFileEditTool(input.toolName) && targets.size > 0;
	return input.effects.map((effect) => {
		if (readOnly) return { ...effect, attribution: "shadow", shadow_reason: "read-only-tool" };
		if (byTarget) {
			return targets.has(effect.path)
				? { ...effect, attribution: "declared-target" }
				: { ...effect, attribution: "shadow", shadow_reason: "not-declared-target" };
		}
		return { ...effect, ...windowLabel(input, effect) };
	});
}

/** Remember this actor's ATTRIBUTED effects for the 10-minute dedupe. */
export function recordAttributedTouches(actorKey: string, effects: readonly AttributableEffect[], nowMs: number): void {
	for (const effect of effects) {
		if (effect.attribution === "shadow") continue;
		const key = touchKey(effect);
		if (recentTouches.has(key)) continue; // first reporter keeps the change
		recentTouches.set(key, { actorKey, atMs: nowMs });
	}
	while (recentTouches.size > RECENT_TOUCH_CEILING) {
		const oldest = recentTouches.keys().next().value;
		if (oldest === undefined) break;
		recentTouches.delete(oldest);
	}
}

/** Test seam. */
export function resetTouchAttribution(): void {
	recentTouches.clear();
}
