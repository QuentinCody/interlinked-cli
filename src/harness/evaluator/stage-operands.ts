// ===========================================
// Stage operands — which existing files a shell stage reads
// ===========================================
// The secret-output origin classifier asks "did every byte this command
// printed come from a file fetched off the public internet?". That needs the
// set of existing files each stage reads. This module answers it for a small
// allowlist of read-only filters (rg, grep, cat, head, jq, …), resolving
// relative paths through the same cd-hop / `VAR=` logic the bash write guard
// uses (`resolveBashWriteTarget`).
//
// Null means "not modeled" and is the fail-safe answer: a directory operand
// (recursive search of unknown files), an unresolved variable, a wildcard
// directory, a device, an interpreter, or a filter flag that runs a command
// or reads the environment.

import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";
import { commandHead, hasUnresolvedVar, type Stage } from "./bash-stage-parse.js";

/** Read-only filters whose output is derived from their input files / stdin. */
export const FILTER_HEADS: ReadonlySet<string> = new Set([
	"rg", "grep", "egrep", "fgrep", "cat", "head", "tail", "wc", "cut", "sort", "uniq", "tr", "jq", "tee",
	"base64", "xxd", "od", "strings", "nl", "tac", "rev", "column", "fold",
]);

/** Statements that print nothing a secret could come from. */
export const CONTROL_HEADS: ReadonlySet<string> = new Set(["cd", "true", ":", "for", "done", "fi", "mkdir"]);

/** Filter flags that run another program or read the environment. */
const UNSAFE_FILTER_ARG: Readonly<Record<string, RegExp>> = {
	rg: /^--pre(?:-glob)?(?:=|$)/,
	jq: /\$ENV|\benv\b|input_filename|\$__loc__/,
	sort: /^--compress-program/,
};

export interface OperandContext {
	command: string;
	cwd: string;
}

/** Path candidates inside one argv token: the token, a `--flag=VALUE` value,
 *  or an `@file` reference (curl data files). */
function candidates(token: string): string[] {
	if (token === "-" || token === "") return [];
	if (token.startsWith("-")) {
		const eq = token.indexOf("=");
		return eq > 0 ? [token.slice(eq + 1)] : [];
	}
	return [token.startsWith("@") ? token.slice(1) : token];
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** Existing regular file → [path]; missing → []; anything else → null. */
function pathFiles(abs: string): string[] | null {
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(abs);
	} catch {
		return [];
	}
	if (st.isFile()) return [canonical(abs)];
	return abs === "/dev/null" ? [] : null;
}

function globRegExp(pattern: string): RegExp {
	const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
	return new RegExp(`^${body}$`);
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/** Expand a wildcard in the LAST path segment the way bash would. A pattern
 *  matching nothing stays literal (bash passes it through; nothing is read). */
function globFiles(abs: string): string[] | null {
	const pattern = basename(abs);
	const re = globRegExp(pattern);
	const out: string[] = [];
	for (const name of listDir(dirname(abs))) {
		if (!re.test(name) || (name.startsWith(".") && !pattern.startsWith("."))) continue;
		const files = pathFiles(join(dirname(abs), name));
		if (files === null) return null;
		out.push(...files);
	}
	return out;
}

/** A wildcard in a DIRECTORY segment: not modeled when it matches anything. */
function wildcardDirMatches(abs: string): boolean {
	const segments = abs.split("/");
	const at = segments.findIndex((s) => /[*?]/.test(s));
	const parent = segments.slice(0, at).join("/") || "/";
	const re = globRegExp(segments[at] ?? "");
	return listDir(parent).some((name) => re.test(name));
}

const ENV_PATH = /^\$(?:HOME|\{HOME\}|TMPDIR|\{TMPDIR\})\//;

function candidateFiles(ctx: OperandContext, stage: Stage, cand: string): string[] | null {
	if (hasUnresolvedVar(cand) && !(ENV_PATH.test(cand) && !hasUnresolvedVar(cand.slice(2)))) return null;
	const abs = resolveBashWriteTarget(ctx.command.slice(0, stage.end), cand, ctx.cwd);
	if (abs === null || hasUnresolvedVar(abs)) return null;
	if (/[*?]/.test(dirname(abs))) return wildcardDirMatches(abs) ? null : [];
	return /[*?]/.test(basename(abs)) ? globFiles(abs) : pathFiles(abs);
}

/** Existing files the stage reads (argv operands and `<` inputs), canonical
 *  paths; `exclude` names argument values that are outputs, not inputs. */
export function stageInputFiles(
	ctx: OperandContext,
	stage: Stage,
	argv: readonly string[],
	exclude: ReadonlySet<string>,
): string[] | null {
	const files: string[] = [];
	for (const token of [...argv.slice(1), ...stage.inputs]) {
		for (const cand of candidates(token)) {
			if (exclude.has(cand)) continue;
			const found = candidateFiles(ctx, stage, cand);
			if (found === null) return null;
			files.push(...found);
		}
	}
	return files;
}

/** Input files of a read-only filter stage, or null when the stage is not one. */
export function filterInputs(ctx: OperandContext, stage: Stage, argv: readonly string[]): string[] | null {
	const head = commandHead(argv[0]);
	if (!FILTER_HEADS.has(head)) return null;
	const unsafe = UNSAFE_FILTER_ARG[head];
	if (unsafe && argv.some((t) => unsafe.test(t))) return null;
	const outputs = head === "tee" ? new Set(argv.slice(1)) : new Set<string>();
	return stageInputFiles(ctx, stage, argv, outputs);
}
