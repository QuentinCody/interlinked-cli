// ===========================================
// Tool-call sequence tally — counting layer for sequence pattern detection
// ===========================================
// A tool sequence entry is "<tool>" or "<tool>:<target>". This module folds a
// sequence into the counts the sequence-feature detector matches against:
// how many edits / reads / shell commands, the longest run of edits to one
// file, and how many edits have happened since the last test command.
//
// Pure functions, no I/O.
import { nonNull } from "../lib/non-null.js";

export interface SequenceTally {
	editCount: number;
	readCount: number;
	bashCount: number;
	testCount: number;
	lastEditFile: string;
	consecutiveEditsToSameFile: number;
	maxConsecutiveEdits: number;
	editsSinceLastTest: number;
}

function isEditTool(tool: string): boolean {
	return [
		"Write",
		"Edit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"NotebookEdit",
	].includes(tool);
}

function isReadTool(tool: string): boolean {
	return ["Read", "ReadFile", "read_file", "Glob", "Grep"].includes(tool);
}

function isBashCommand(tool: string): boolean {
	return ["Bash", "Shell", "shell", "run_command"].includes(tool);
}

function isTestCommand(target: string): boolean {
	return /\b(test|vitest|jest|mocha|pytest|cargo test|go test|npm run test|npx vitest)\b/i.test(
		target,
	);
}

/** Fold one edit-tool entry into the running tally. */
function tallyEditEntry(tally: SequenceTally, target: string | undefined): void {
	tally.editCount++;
	tally.editsSinceLastTest++;
	if (target === tally.lastEditFile) {
		tally.consecutiveEditsToSameFile++;
		tally.maxConsecutiveEdits = Math.max(
			tally.maxConsecutiveEdits,
			tally.consecutiveEditsToSameFile,
		);
	} else {
		tally.consecutiveEditsToSameFile = 1;
		tally.lastEditFile = target || "";
	}
}

/** Fold one shell-tool entry into the running tally. */
function tallyBashEntry(tally: SequenceTally, target: string | undefined): void {
	tally.bashCount++;
	if (isTestCommand(target || "")) {
		tally.testCount++;
		tally.editsSinceLastTest = 0;
	}
}

/** Count tool families, edit runs, and edits-since-test across a sequence. */
export function tallySequence(sequence: string[]): SequenceTally {
	const tally: SequenceTally = {
		editCount: 0,
		readCount: 0,
		bashCount: 0,
		testCount: 0,
		lastEditFile: "",
		consecutiveEditsToSameFile: 0,
		maxConsecutiveEdits: 0,
		editsSinceLastTest: 0,
	};

	for (const entry of sequence) {
		const parts = entry.split(":", 2);
		const tool = nonNull(parts[0]);
		const target = parts[1];

		if (isEditTool(tool)) {
			tallyEditEntry(tally, target);
		} else if (isReadTool(tool)) {
			tally.readCount++;
		} else if (isBashCommand(tool)) {
			tallyBashEntry(tally, target);
		}
	}

	return tally;
}
