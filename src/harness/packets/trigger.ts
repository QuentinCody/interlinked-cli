// Instruction packets — the deterministic trigger (design §4 `applies`, §6 gate 4).
//
// ONE matcher for both consumers: the replay dry run (collection rows) and the
// daemon (hook events) build the same `TriggerView` and ask the same question,
// so a packet's replay hit count and its live fire set are the same population.
// Pure: no I/O, no model. A null regex is no constraint; a set regex with no
// matching evidence (command regex on an edit, path regex on a command) is a
// non-match, never a pass.

import { extractApplyPatchRaw, parseApplyPatchSections } from "../apply-patch-content.js";
import { readToolString } from "../evaluator/tool-input-values.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { PacketApplies, PacketSettle } from "./types.js";

export interface TriggerHunk {
	old: string;
	new: string;
}

/** What a trigger can see of one tool call (one view per file for a multi-file patch). */
export interface TriggerView {
	tool: string;
	phase: "pre" | "post";
	path: string | null;
	command: string | null;
	hunks: TriggerHunk[];
}

function test(pattern: string | null, subject: string | null): boolean {
	if (pattern === null) return true;
	if (subject === null) return false;
	return new RegExp(pattern).test(subject);
}

export function matchesTrigger(applies: PacketApplies, view: TriggerView): boolean {
	if (applies.phase !== view.phase) return false;
	if (!applies.tools.includes(view.tool)) return false;
	if (!test(applies.command_regex, view.command)) return false;
	const path = view.path === null ? null : view.path.replace(/\\/g, "/");
	if (!test(applies.path_regex, path)) return false;
	if (applies.exclude_path_regex !== null && path !== null && new RegExp(applies.exclude_path_regex).test(path)) return false;
	if (applies.new_text_regex !== null) {
		const re = new RegExp(applies.new_text_regex);
		if (!view.hunks.some((h) => re.test(h.new))) return false;
	}
	return true;
}

function hunksOf(tool: string, input: JsonObject): TriggerHunk[] {
	if (tool === "Write") return [{ old: "", new: readToolString(input.content) }];
	if (tool === "Edit") return [{ old: readToolString(input.old_string), new: readToolString(input.new_string) }];
	const edits = Array.isArray(input.edits) ? input.edits : [];
	return edits.flatMap((e: unknown) => {
		if (typeof e !== "object" || e === null || Array.isArray(e)) return [];
		const row = e as JsonObject;
		return [{ old: readToolString(row.old_string), new: readToolString(row.new_string) }];
	});
}

/** The views one tool call presents to the triggers. */
export function viewsFromToolInput(tool: string, phase: "pre" | "post", input: JsonObject): TriggerView[] {
	if (tool === "Bash") return [{ tool, phase, path: null, command: readToolString(input.command), hunks: [] }];
	if (tool === "apply_patch") {
		return parseApplyPatchSections(extractApplyPatchRaw(input))
			.filter((s) => s.op !== "delete")
			.map((s) => ({ tool, phase, path: s.path, command: null, hunks: [{ old: "", new: s.body.join("\n") }] }));
	}
	const path = readToolString(input.file_path);
	if (!path) return [];
	return [{ tool, phase, path, command: null, hunks: hunksOf(tool, input) }];
}

export type Settled = "compliant" | "violated" | null;

/** The text a decider reads: the command, or every hunk's new text joined. */
export function settleSubject(view: TriggerView): string {
	return view.command ?? view.hunks.map((h) => h.new).join("\n");
}

/** Decide without a model when a regex can: compliant wins over violated; null = the model's residue. */
export function settleView(settle: PacketSettle, view: TriggerView): Settled {
	const subject = settleSubject(view);
	if (settle.compliant_regex !== null && new RegExp(settle.compliant_regex).test(subject)) return "compliant";
	if (settle.violated_regex !== null && new RegExp(settle.violated_regex).test(subject)) return "violated";
	return null;
}
