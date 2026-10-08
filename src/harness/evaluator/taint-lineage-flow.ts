// ===========================================
// File-mediated taint flow between actors (H3 option B5)
// ===========================================
// Per-actor levels (taint-lineage.ts) free a clean sibling from another
// actor's ratchet, which leaves one channel open: the filesystem. This module
// closes it in both directions.
//
//   WRITE (PostToolUse): a file an actor above Public wrote is recorded in the
//     tainted-file store with that actor's level. Covers Write / Edit /
//     MultiEdit / apply_patch targets, shell redirect + `tee` targets resolved
//     through `resolveBashWriteTarget` (same-command `VAR=` and `cd` hops), and
//     the resolved target of an inline interpreter program.
//   READ (PreToolUse): when the acting actor reads a recorded path — the Read
//     tool's `file_path`, or a read operand of a Bash filter stage
//     (`stage-operands.ts`) — its level ratchets to the recorded one BEFORE the
//     network block runs, so reading and sending in one command still blocks.
//
// Fail-safe both ways: an unresolvable write target is simply not recorded
// (the writer itself stays tainted, so its own calls stay blocked), and a read
// shape the operand model does not cover ratchets nothing — the pre-existing
// path-glob and secret-scan ratchets still apply there.

import { resolve } from "node:path";
import { resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import { recordTaintedFile, taintedFilesMatching } from "../taint-file-lineage.js";
import { actorLevel } from "../taint-lineage.js";
import { ratchetActorSensitivity, SENSITIVITY_ORDER } from "../taint-tracker.js";
import type { HarnessEvent, SessionTrajectory, TaintTrackingConfig } from "../types.js";
import { commandHead, splitPipelines } from "./bash-stage-parse.js";
import { interpreterWriteTargets } from "./interpreter-write-guard.js";
import { filterInputs, type OperandContext } from "./stage-operands.js";
import { isBash, isFileWrite, isReadOperation } from "./tool-classifiers.js";
import { readToolString } from "./tool-input-values.js";

/** One tool call's taint-flow context. */
export interface FlowContext {
	toolName: string;
	toolInput: Record<string, unknown>;
	taint: TaintTrackingConfig;
	session: SessionTrajectory;
	/** `actorKeyOf` of the calling actor; undefined → session-wide semantics. */
	actor: string | undefined;
}

/** Shell write targets of one stage: its `>` / `>>` redirects plus `tee`
 *  arguments. */
function stageWriteTargets(argv: readonly string[], outputs: readonly string[]): string[] {
	if (commandHead(argv[0]) !== "tee") return [...outputs];
	return [...outputs, ...argv.slice(1).filter((t) => !t.startsWith("-"))];
}

/** Absolute shell write targets of a Bash command, resolved the way the write
 *  guards resolve them. An unresolvable target is dropped. */
function bashWriteTargets(command: string, cwd: string): string[] {
	const out: string[] = [];
	for (const pipeline of splitPipelines(command)) {
		for (const stage of pipeline.stages) {
			for (const target of stageWriteTargets(stage.argv, stage.outputs)) {
				const abs = resolveBashWriteTarget(command.slice(0, stage.end), target, cwd);
				if (abs !== null && abs.startsWith("/")) out.push(abs);
			}
		}
	}
	return out;
}

/** Every path this tool call wrote, absolute. */
function writtenPaths(event: HarnessEvent, cwd: string): string[] {
	const toolName = event.tool_name || "";
	if (isFileWrite(toolName) || toolName === "apply_patch") {
		return extractAllEditedFilePaths(event).map((p) => resolve(cwd, p));
	}
	if (!isBash(toolName)) return [];
	const command = readToolString(event.tool_input?.command);
	if (!command) return [];
	return [...bashWriteTargets(command, cwd), ...interpreterWriteTargets(command, cwd)];
}

/**
 * PostToolUse: record the files this call wrote at the WRITER's level, so a
 * later read by another actor ratchets the reader. No-op for a writer at
 * Public, for a dry run, and when taint tracking is off.
 */
export function recordActorWrites(
	event: HarnessEvent,
	taint: TaintTrackingConfig | undefined,
	session: SessionTrajectory | undefined,
	actor: string | undefined,
): void {
	if (!session || !taint?.enabled || event.dry_run === true) return;
	const level = actorLevel(session, actor);
	if (level === "Public") return;
	const cwd = event.cwd || process.cwd();
	const writer = actor ?? session.session_id;
	for (const path of new Set(writtenPaths(event, cwd))) {
		recordTaintedFile(session, { path, level, writer, at_step: session.tool_call_count });
	}
}

/** Read operands of every modeled filter stage of a Bash command. */
function bashReadPaths(command: string, cwd: string): string[] {
	const operands: string[] = [];
	const operandCtx: OperandContext = { command, cwd };
	for (const pipeline of splitPipelines(command)) {
		for (const stage of pipeline.stages) {
			if (stage.dynamic) continue;
			operands.push(...(filterInputs(operandCtx, stage, stage.argv) ?? []));
		}
	}
	return operands;
}

/** Absolute paths this call READS: the Read tool's target, or the input
 *  operands of each Bash filter stage (`rg`, `cat`, `jq`, …). */
function readPaths(ctx: FlowContext, cwd: string): string[] {
	if (isReadOperation(ctx.toolName)) {
		const filePath = readToolString(ctx.toolInput.file_path);
		return filePath ? [resolve(cwd, filePath)] : [];
	}
	if (!isBash(ctx.toolName)) return [];
	const command = readToolString(ctx.toolInput.command);
	return command ? bashReadPaths(command, cwd) : [];
}

/**
 * Ratchet the acting actor when it reads a file a tainted actor wrote (B5).
 * Returns one warning line per ratchet. Called from the PreToolUse taint guard
 * before the network block, so a read-then-send inside ONE command is caught.
 */
export function ratchetOnTaintedFileRead(ctx: FlowContext): string[] {
	const { session, actor, taint } = ctx;
	if (!taint.enabled) return [];
	const cwd = readToolString(ctx.toolInput.cwd) || process.cwd();
	const warnings: string[] = [];
	for (const path of new Set(readPaths(ctx, cwd))) {
		for (const entry of taintedFilesMatching(session, path)) {
			if (SENSITIVITY_ORDER[entry.level] <= SENSITIVITY_ORDER[actorLevel(session, actor)]) continue;
			const detail = `written at ${entry.level} by ${entry.writer} at step ${entry.at_step}`;
			ratchetActorSensitivity(session, actor, { file: entry.path, level: entry.level, detail }, taint);
			warnings.push(
				`[interlinked:taint] Sensitivity escalated to ${entry.level} after reading ${entry.path} (${detail}). Outbound network commands will be BLOCKED.`,
			);
		}
	}
	return warnings;
}
