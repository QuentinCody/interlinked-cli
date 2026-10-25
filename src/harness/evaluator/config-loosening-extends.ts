// Effective-strictness arm of the config-loosening gate (red team 2026-10-21,
// "extends-chain redirection").
//
// The per-file comparison in `config-loosening-gate.ts` reads only the edited
// tsconfig's OWN `compilerOptions`. Three shapes loosened the EFFECTIVE config
// with every per-file diff green:
//   (a) repoint `extends` at a looser base (own keys byte-identical);
//   (b) create a new, untracked tsconfig (no HEAD ⇒ no comparison) that a
//       tracked tsconfig now extends;
//   (c) edit an extends TARGET so a tsconfig that extends it gets looser
//       without the target itself getting looser (the target adds
//       `noImplicitAny: false`; the referencer carries `strict: true`).
//
// This module resolves the full `extends` chain on both sides — every file
// read from git HEAD on the before side, from disk with the edited file
// replaced by its proposed bytes on the after side — and reports a flag only
// when it is strict at HEAD, strict in the current on-disk state (so earlier,
// unrelated drift is not blamed on this edit), and loose after the edit.
// Only local relative/absolute `extends` paths are followed. A package
// specifier, a missing target, a cycle or an unparsable file is UNDECIDABLE:
// the gate allows and the caller surfaces the detail as a warning.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

/** Reads one config file by absolute path; `null` = the file does not exist. */
export type ConfigReader = (absPath: string) => string | null;

export type EffectiveOutcome =
	| { kind: "ok"; compilerOptions: JsonObject; chain: string[] }
	| { kind: "undecidable"; detail: string; chain: string[] };

type ParseFn = (text: string) => unknown;

const MAX_EXTENDS_DEPTH = 16;
const MAX_REFERENCERS = 256;
const GIT_TIMEOUT_MS = 1500;

/** `extends` as a list of specifiers, or an error string for a bad shape. */
function extendsSpecifiers(cfg: JsonObject): string[] | string {
	const ext = cfg.extends;
	if (ext === undefined) return [];
	if (typeof ext === "string") return [ext];
	if (Array.isArray(ext) && ext.every((e): e is string => typeof e === "string")) return ext;
	return `\`extends\` has a non-string shape (${JSON.stringify(ext)})`;
}

/** TypeScript follows `./`, `../` and absolute paths as files; every other
 *  specifier is a node-module lookup this gate does not perform. */
function isLocalSpecifier(spec: string): boolean {
	return spec.startsWith("./") || spec.startsWith("../") || isAbsolute(spec);
}

/** Candidate files for a local specifier: as written, then with `.json`. */
function extendsCandidates(fromFile: string, spec: string): string[] {
	const target = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);
	return target.endsWith(".json") ? [target] : [target, `${target}.json`];
}

interface ResolveCtx {
	read: ConfigReader;
	parse: ParseFn;
	chain: string[];
	label: (abs: string) => string;
}

function undecidable(ctx: ResolveCtx, detail: string): EffectiveOutcome {
	return { kind: "undecidable", detail, chain: ctx.chain };
}

/** Resolve one extends specifier of `fromFile` to its own effective options. */
function resolveSpecifier(
	ctx: ResolveCtx,
	fromFile: string,
	spec: string,
	stack: string[],
): EffectiveOutcome {
	if (!isLocalSpecifier(spec)) {
		return undecidable(ctx, `${ctx.label(fromFile)} extends "${spec}", a package specifier this gate does not resolve`);
	}
	for (const candidate of extendsCandidates(fromFile, spec)) {
		if (ctx.read(candidate) !== null) return resolveFile(ctx, candidate, stack);
	}
	return undecidable(ctx, `${ctx.label(fromFile)} extends "${spec}", which does not exist on this side`);
}

function resolveFile(ctx: ResolveCtx, absPath: string, stack: string[]): EffectiveOutcome {
	if (stack.includes(absPath)) return undecidable(ctx, `extends cycle through ${ctx.label(absPath)}`);
	if (stack.length >= MAX_EXTENDS_DEPTH) return undecidable(ctx, `extends chain deeper than ${MAX_EXTENDS_DEPTH}`);
	ctx.chain.push(absPath);
	const text = ctx.read(absPath);
	if (text === null) return undecidable(ctx, `${ctx.label(absPath)} does not exist on this side`);
	const parsed = ctx.parse(text);
	if (!isJsonObject(parsed)) return undecidable(ctx, `${ctx.label(absPath)} is not a parsable JSON object`);
	const specs = extendsSpecifiers(parsed);
	if (typeof specs === "string") return undecidable(ctx, `${ctx.label(absPath)}: ${specs}`);
	let merged: JsonObject = {};
	for (const spec of specs) {
		const base = resolveSpecifier(ctx, absPath, spec, [...stack, absPath]);
		if (base.kind === "undecidable") return base;
		// Later array entries override earlier ones, as in TypeScript ≥ 5.0.
		merged = { ...merged, ...base.compilerOptions };
	}
	const own = parsed.compilerOptions;
	return { kind: "ok", compilerOptions: { ...merged, ...(isJsonObject(own) ? own : {}) }, chain: ctx.chain };
}

/** Public API — the effective `compilerOptions` of `absPath` under `read`. */
export function resolveEffectiveCompilerOptions(
	absPath: string,
	read: ConfigReader,
	parse: ParseFn,
	label: (abs: string) => string = (p) => p,
): EffectiveOutcome {
	return resolveFile({ read, parse, chain: [], label }, absPath, []);
}

// ==========================================================================
// Readers (git HEAD side, disk side)
// ==========================================================================

function gitRepoRoot(dir: string): string | null {
	const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
		encoding: "utf-8",
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.status !== 0 || !r.stdout) return null;
	return r.stdout.trim();
}

function headReader(repoRoot: string): ConfigReader {
	const memo = new Map<string, string | null>();
	return (absPath) => {
		const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..")) return null;
		const cached = memo.get(rel);
		if (cached !== undefined) return cached;
		const r = spawnSync("git", ["-C", repoRoot, "show", `HEAD:${rel}`], {
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
		});
		const text = r.status === 0 ? r.stdout : null;
		memo.set(rel, text);
		return text;
	};
}

function diskReader(override?: { path: string; text: string }): ConfigReader {
	return (absPath) => {
		if (override && absPath === override.path) return override.text;
		if (!existsSync(absPath)) return null;
		try {
			return readFileSync(absPath, "utf-8");
		} catch {
			return null;
		}
	};
}

/** Tracked tsconfig*.json files of the repository (bounded). */
function trackedTsconfigs(repoRoot: string): string[] {
	const r = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", ":(glob)**/tsconfig*.json"], {
		encoding: "utf-8",
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.status !== 0 || !r.stdout) return [];
	return r.stdout
		.split("\0")
		.filter((rel) => rel.length > 0)
		.slice(0, MAX_REFERENCERS)
		.map((rel) => join(repoRoot, rel));
}

// ==========================================================================
// Edit judgment
// ==========================================================================

export interface EffectiveJudgeInput<F extends { rule: string }> {
	/** Absolute path of the edited tsconfig. */
	filePath: string;
	/** Proposed bytes of the edited file. */
	proposed: string;
	/** Bytes on disk before the edit (`null` when the file does not exist). */
	previous: string | null;
	parse: ParseFn;
	/** Flags whose values decide strictness; an edit touching none of them and
	 *  not touching `extends` cannot change the effective strictness. */
	trackedFlags: readonly string[];
	/** Per-flag comparison of two effective `compilerOptions` objects. */
	compare: (subject: string, before: JsonObject, after: JsonObject) => F[];
}

export interface EffectiveFinding<F> {
	subject: string;
	/** True when the subject is the edited file itself (not a referencer). */
	isEditedFile: boolean;
	chain: string[];
	finding: F;
}

export interface EffectiveJudgment<F> {
	findings: EffectiveFinding<F>[];
	undecided: string[];
}

/** True when the edit changes `extends` or any tracked flag's own value. */
function editTouchesStrictness(
	previous: unknown,
	proposed: unknown,
	trackedFlags: readonly string[],
): boolean {
	const prev = isJsonObject(previous) ? previous : {};
	const next = isJsonObject(proposed) ? proposed : {};
	if (JSON.stringify(prev.extends) !== JSON.stringify(next.extends)) return true;
	const prevCo = isJsonObject(prev.compilerOptions) ? prev.compilerOptions : {};
	const nextCo = isJsonObject(next.compilerOptions) ? next.compilerOptions : {};
	return trackedFlags.some((flag) => JSON.stringify(prevCo[flag]) !== JSON.stringify(nextCo[flag]));
}

interface Sides {
	edited: string;
	head: ConfigReader;
	current: ConfigReader;
	after: ConfigReader;
	label: (abs: string) => string;
}

function judgeSubject<F extends { rule: string }>(
	subject: string,
	sides: Sides,
	input: EffectiveJudgeInput<F>,
	out: EffectiveJudgment<F>,
): void {
	const isEditedFile = subject === sides.edited;
	const name = sides.label(subject);
	const before = resolveEffectiveCompilerOptions(subject, sides.head, input.parse, sides.label);
	if (before.kind === "undecidable") {
		out.undecided.push(`effective strictness of ${name} not compared (HEAD side: ${before.detail})`);
		return;
	}
	const after = resolveEffectiveCompilerOptions(subject, sides.after, input.parse, sides.label);
	if (after.kind === "undecidable") {
		out.undecided.push(`effective strictness of ${name} not compared (after the edit: ${after.detail})`);
		return;
	}
	const current = resolveEffectiveCompilerOptions(subject, sides.current, input.parse, sides.label);
	const stillStrictNow =
		current.kind === "ok"
			? new Set(input.compare(subject, current.compilerOptions, after.compilerOptions).map((f) => f.rule))
			: null;
	for (const finding of input.compare(subject, before.compilerOptions, after.compilerOptions)) {
		// A flag already loose on disk before this edit is earlier drift, not this edit.
		if (stillStrictNow && !stillStrictNow.has(finding.rule)) continue;
		out.findings.push({ subject: name, isEditedFile, chain: after.chain.map(sides.label), finding });
	}
}

/**
 * Public API — the spelling git reports for a path whose directory exists:
 * symlinked directories (macOS `/tmp` → `/private/tmp`) are resolved, so a
 * path compares equal to the chain members built from `git rev-parse`.
 */
export function canonicalPath(absPath: string): string {
	try {
		return join(realpathSync(dirname(absPath)), basename(absPath));
	} catch {
		return absPath;
	}
}

/**
 * Public API — true when `absPath` (a `.json` file of any name) is a member of
 * the extends chain of a tracked tsconfig, at HEAD or on disk (red team
 * 2026-10-21 round 3, WF6): `extends: "./packages/tsconfig/base.json"` or
 * `"./configs/c.json"` makes that file a strictness water-line even though its
 * name is not `tsconfig*.json`. False outside a git repository.
 */
export function isTrackedExtendsMember(absPath: string, parse: ParseFn): boolean {
	if (!absPath.endsWith(".json")) return false;
	const filePath = canonicalPath(resolve(absPath));
	const repoRoot = gitRepoRoot(dirname(filePath));
	if (repoRoot === null || relative(repoRoot, filePath).startsWith("..")) return false;
	const head = headReader(repoRoot);
	const disk = diskReader();
	return trackedTsconfigs(repoRoot).some(
		(abs) =>
			abs !== filePath &&
			(resolveEffectiveCompilerOptions(abs, head, parse).chain.includes(filePath) ||
				resolveEffectiveCompilerOptions(abs, disk, parse).chain.includes(filePath)),
	);
}

/** Tracked tsconfigs (other than the edited file) whose before- or after-side
 *  chain passes through the edited file. */
function referencersOf(filePath: string, repoRoot: string, sides: Sides, parse: ParseFn): string[] {
	return trackedTsconfigs(repoRoot).filter((abs) => {
		if (abs === filePath) return false;
		const viaAfter = resolveEffectiveCompilerOptions(abs, sides.after, parse).chain;
		const viaHead = resolveEffectiveCompilerOptions(abs, sides.head, parse).chain;
		return viaAfter.includes(filePath) || viaHead.includes(filePath);
	});
}

/**
 * Public API — judge a proposed tsconfig edit by EFFECTIVE strictness: the
 * edited file itself (when HEAD has it) and every tracked tsconfig whose
 * extends chain passes through it. Returns decided loosenings plus the
 * comparisons that could not be decided.
 */
export function judgeEffectiveStrictness<F extends { rule: string }>(
	input: EffectiveJudgeInput<F>,
): EffectiveJudgment<F> {
	const out: EffectiveJudgment<F> = { findings: [], undecided: [] };
	const proposedParsed = input.parse(input.proposed);
	if (!isJsonObject(proposedParsed)) return out;
	const isNew = input.previous === null;
	if (!isNew && !editTouchesStrictness(input.parse(input.previous ?? ""), proposedParsed, input.trackedFlags)) {
		return out;
	}
	const filePath = resolve(input.filePath);
	const repoRoot = gitRepoRoot(dirname(filePath));
	// Same fail-open rule as the per-file arm (`readHeadVersion`): a path that
	// does not resolve inside the root git reports has no locatable baseline.
	if (repoRoot === null || relative(repoRoot, filePath).startsWith("..")) return out;
	const sides: Sides = {
		edited: filePath,
		head: headReader(repoRoot),
		current: diskReader(),
		after: diskReader({ path: filePath, text: input.proposed }),
		label: (abs) => relative(repoRoot, abs).replace(/\\/g, "/") || abs,
	};
	if (sides.head(filePath) !== null) judgeSubject(filePath, sides, input, out);
	for (const referencer of referencersOf(filePath, repoRoot, sides, input.parse)) {
		judgeSubject(referencer, sides, input, out);
	}
	return out;
}
