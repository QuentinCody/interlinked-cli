// ===========================================
// interlinked harness test — synthetic event construction
// ===========================================
// Builds the PreToolUse event that `interlinked harness test --write/--edit`
// (and the legacy positional Bash form) sends over the harness socket. The
// flag→event mapping is split into a pure constructor (`buildHarnessTestEvent`,
// no I/O, unit-testable without a live daemon) and an async resolver
// (`resolveHarnessTestInput`, reads --from-file / --stdin and resolves the
// path). Extracted from harness.ts to keep that file under the per-file line
// cap. The tool_input shapes mirror what the evaluator reads in pre-tool.ts.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../lib/json-types.js";

/** Options accepted by `interlinked harness test`. The positional command is
 *  the Bash/file path argument; `write`/`edit` opt into the synthetic
 *  Write/Edit modes that fire a PreToolUse event at the live daemon. */
export interface HarnessTestOpts {
	tool?: string;
	json?: boolean;
	write?: string;
	edit?: string;
	old?: string;
	new?: string;
	fromFile?: string;
	stdin?: boolean;
}

/** The synthetic PreToolUse event the test command sends over the socket,
 *  paired with the human-readable label printed beside the decision. */
interface HarnessTestPlan {
	toolName: string;
	displayLabel: string;
	event: JsonObject;
}

/** Resolved (post-I/O) inputs the pure event builder works from. The async
 *  resolver reads stdin/from-file content and resolves the absolute path
 *  first; this tagged union enumerates the three event shapes the daemon
 *  understands. */
export type HarnessTestInput =
	| { kind: "bash"; toolName: string; command: string }
	| { kind: "write"; filePath: string; content: string }
	| { kind: "edit"; filePath: string; oldString: string; newString: string };

/**
 * Pure constructor: map a resolved input into the PreToolUse event the harness
 * socket expects. No I/O — every value is already resolved by the caller — so
 * the flag→event mapping is unit-testable without a live daemon. Mirrors the
 * tool_input shapes the evaluator reads (`pre-tool.ts`): Write carries
 * `{ file_path, content }`, Edit `{ file_path, old_string, new_string }`,
 * Bash/Shell `{ command }`, any other tool a bare `{ file_path }`.
 */
export function buildHarnessTestEvent(input: HarnessTestInput): HarnessTestPlan {
	let toolName: string;
	let displayLabel: string;
	let toolInput: JsonObject;
	if (input.kind === "write") {
		toolName = "Write";
		displayLabel = input.filePath;
		toolInput = { file_path: input.filePath, content: input.content };
	} else if (input.kind === "edit") {
		toolName = "Edit";
		displayLabel = input.filePath;
		toolInput = {
			file_path: input.filePath,
			old_string: input.oldString,
			new_string: input.newString,
		};
	} else {
		toolName = input.toolName;
		displayLabel = input.command;
		// Shell-shaped tools carry the command; everything else a file path.
		toolInput =
			toolName === "Bash" || toolName === "Shell"
				? { command: input.command }
				: { file_path: input.command };
	}

	const event: JsonObject = {
		hook_event: "PreToolUse",
		// This command SIMULATES a tool call; nothing is written to disk. The
		// marker tells the daemon's evaluators to compute the verdict but persist
		// nothing — otherwise a probe opens real obligations against files it
		// never touched and those block later, genuine edits.
		dry_run: true,
		session_id: "cli-test",
		agent_source: "claude",
		agent_name: "test",
		tool_name: toolName,
		tool_input: toolInput,
		timestamp: new Date().toISOString(),
	};
	return { toolName, displayLabel, event };
}

/** Read stdin to EOF as UTF-8. Used by `--write … --stdin`. */
function readHarnessTestStdin(): Promise<string> {
	return new Promise<string>((res, rej) => {
		const chunks: Buffer[] = [];
		process.stdin.on("data", (ch: Buffer) => chunks.push(ch));
		process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf-8")));
		process.stdin.on("error", rej);
	});
}

/** Resolve a user-supplied path to an absolute one against `cwd`. */
function toAbsolute(filePath: string, cwd: string): string {
	return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

/**
 * Resolve flags + (async) content into the tagged input the pure builder
 * consumes. Throws an Error with a usage-level message on bad flag
 * combinations; the caller routes it to `outputError`.
 */
export async function resolveHarnessTestInput(
	command: string | undefined,
	opts: HarnessTestOpts,
	cwd: string,
): Promise<HarnessTestInput> {
	if (opts.write !== undefined) {
		const content = await resolveProposedContent(opts);
		return { kind: "write", filePath: toAbsolute(opts.write, cwd), content };
	}

	if (opts.edit !== undefined) {
		if (opts.old === undefined || opts.new === undefined) {
			throw new Error("--edit requires both --old <str> and --new <str>.");
		}
		return {
			kind: "edit",
			filePath: toAbsolute(opts.edit, cwd),
			oldString: opts.old,
			newString: opts.new,
		};
	}

	if (command === undefined) {
		throw new Error(
			"Provide a <command>, or use --write <file> (--from-file/--stdin) or --edit <file> --old --new.",
		);
	}
	return { kind: "bash", toolName: opts.tool || "Bash", command };
}

/** Read the proposed Write content from --stdin or --from-file. */
async function resolveProposedContent(opts: HarnessTestOpts): Promise<string> {
	if (opts.stdin) {
		return readHarnessTestStdin();
	}
	if (opts.fromFile !== undefined) {
		if (!existsSync(opts.fromFile)) {
			throw new Error(`Source file not found: ${opts.fromFile}`);
		}
		return readFileSync(opts.fromFile, "utf-8");
	}
	throw new Error("--write requires --from-file <path> or --stdin for the proposed content.");
}
