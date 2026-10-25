// Proposed-content reconstruction for the baseline-integrity gate.
//
// Given a tool call, list every gated baseline it writes (a `.interlinked/`
// water-line or a sibling ledger) together with the on-disk text before the
// call and what the call would leave. Reconstruction lives in
// edit-reconstruction.ts (Write / Edit / MultiEdit with replace_all, every
// runner spelling) and write-targets.ts (which calls write, path resolution,
// V4A sections including a shell heredoc). A target whose result cannot be
// reconstructed is returned as UNDECIDABLE — never dropped — so the gate can
// fail closed on it (red team 2026-10-21: a null here used to mean "allow").
//
// Round 3 (2026-10-21, write classification): which calls are writes comes
// from the ONE registry classifier (`isWriteCapableToolName`), not a private
// list, and every target path is resolved (`~/` expanded, relative paths
// against the event cwd or a shell's `cd` / `workdir`) BEFORE it is classified.

import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import { baselineKind } from "./baseline-kind.js";
import { reconstructToolInput } from "./edit-reconstruction.js";
import { isSiblingBaselinePath } from "./function-complexity-baseline-gate.js";
import { normalizeTargetPath, toolWriteTargets, type WriteTarget } from "./write-targets.js";

/** One gated file a tool call targets. */
export type BaselineProposal = WriteTarget;

/** Reads the current text of a resolved (absolute) path. */
type ReadDisk = (filePath: string) => string | null;

function isGated(filePath: string): boolean {
	const normalized = normalizeTargetPath(filePath);
	return baselineKind(normalized) !== null || isSiblingBaselinePath(normalized);
}

/**
 * Public API — every gated baseline a tool call targets, with its before-text
 * and reconstruction. Empty when the call targets none. Any tool may be
 * passed: a call is judged when it carries a V4A patch (a shell heredoc
 * included) or the registry classifies it as a direct writer. Paths are
 * resolved against `cwd` (default: the process cwd) before classification.
 */
export function baselineProposals(
	toolName: string,
	toolInput: JsonObject,
	readDisk: ReadDisk,
	cwd?: string,
): BaselineProposal[] {
	return toolWriteTargets(toolName, toolInput, cwd, readDisk, isGated);
}

/**
 * Public API — the primary post-edit text for a Write / Edit / MultiEdit input
 * (a Write's `content` when present), or null when the input is undecidable.
 * The gate itself judges every candidate through {@link baselineProposals}.
 */
export function reconstructProposedBaseline(before: string, toolInput: JsonObject): string | null {
	const result = reconstructToolInput(before, toolInput);
	// A decided reconstruction always has at least one candidate, including an empty file's "".
	return result.kind === "decided" ? nonNull(result.contents[0]) : null;
}
