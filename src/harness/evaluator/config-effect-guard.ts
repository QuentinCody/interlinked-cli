// Effect arm for the BLOCKING config water-lines — tsconfig strictness and the
// vitest/vite coverage denominator (red team 2026-10-21, "Shell-write bypass —
// the gate is wired for file-write tools only").
//
// The config-loosening gate's Edit arm compares proposed content with git HEAD
// and its Bash arm (baseline-bash-guard.ts) scans command text. A shell has
// unbounded spellings, so the scanner cannot be the guarantee. This module is
// the guarantee's config half: it snapshots every config water-line before a
// tool call and, after the call, compares the bytes on disk against that
// PRE-CALL snapshot with the same detectors the Edit arm uses.
// baseline-effect-guard.ts orchestrates both halves and restores whatever
// this module reports.
//
// What is snapshotted (bounded, so it fits the per-call budget):
//   - the git-TRACKED tsconfig*.json / vitest*.config.* / vite.config.* files
//     under the project root — the set the Edit arm protects, because its
//     comparison needs a HEAD blob. Discovered with one `git ls-files` per
//     root per DISCOVERY_TTL_MS (measured ~10 ms on this repo, amortized);
//   - matching files directly in the project root, re-listed every call, so
//     an untracked root config is covered too;
//   - a bounded directory walk instead of git when the root is no repository;
//   - every LOCAL `extends` target of a snapshotted tsconfig inside the root,
//     so loosening a base file (whatever its name) is seen through the
//     tsconfig that inherits it.
// At most MAX_CONFIG_FILES files, each read through the caller's byte-capped
// reader (MAX_SNAPSHOT_BYTES in baseline-effect-guard.ts).
//
// Detectors are reached through the thin adapters below, so a signature change
// in config-loosening-gate.ts / config-loosening-extends.ts touches one place.
//
// Residuals (deliberately not decided here): an `extends` package specifier
// ("@tsconfig/node20") is not resolved, so a loosening visible only through a
// package base is missed — the Edit arm has the same limit; an untracked
// config below the root of a git repository is not snapshotted (the Edit arm
// has no HEAD blob to protect it either); a vitest comparison the AST reader
// cannot decide (spread, identifier) is allowed, as on the Edit arm.

import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { detectConfigLoosening } from "./config-loosening-gate.js";
import { resolveEffectiveCompilerOptions } from "./config-loosening-extends.js";
import { parseTsconfigObject, unparseablePostImage } from "./tsconfig-text-parse.js";
import { decideVitestCoverageWaterLine, isVitestConfigFile } from "./vitest-coverage-water-line.js";

/** First words of the agent-facing message when the effect arm restored bytes.
 *  Exported so the PostToolUse call sites recognize a restore and surface it
 *  as a blocking (human-visible) result without re-deriving the text. */
export const BASELINE_RESTORE_PREFIX = "[interlinked:baseline-effect] RESTORED";

/** Raw text of each config water-line at one instant (root-relative keys). */
export type ConfigSnapshot = Readonly<Record<string, string | null>>;

/** Reads one file under the caller's byte cap; null = absent / unreadable / too large. */
export type SnapshotReader = (absPath: string) => string | null;

/** One config file a call loosened, with the bytes needed to undo it. */
export interface ConfigLoosening {
	file: string;
	beforeText: string;
	afterText: string | null;
	details: string[];
}

const TSCONFIG_RE = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/;
const MAX_CONFIG_FILES = 64;
const DISCOVERY_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 1500;
const WALK_MAX_DEPTH = 3;
const WALK_MAX_DIRS = 200;
const WALK_SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "vendor", "scratch"]);

/** True for the basenames whose Edit arm BLOCKS (tsconfig*, vitest/vite config). */
export function isConfigWaterLineName(rel: string): boolean {
	const norm = rel.replace(/\\/g, "/");
	return TSCONFIG_RE.test(norm) || isVitestConfigFile(norm);
}

// ---- adapters onto the detectors this module does not own -----------------

/** Strictness findings between two tsconfig texts (config-loosening-gate.ts). */
function strictnessFindings(rel: string, beforeText: string, afterText: string): string[] {
	return detectConfigLoosening(rel, beforeText, afterText).map((f) => `[${f.rule}] ${f.message}`);
}

/** Effective compilerOptions through the local `extends` chain (absolute
 *  paths), or null options when the chain is undecidable
 *  (config-loosening-extends.ts). */
function effectiveOptions(absPath: string, read: SnapshotReader): { options: JsonObject | null; chain: string[] } {
	// TypeScript's own reading of each chain member (round 4): "" is `{}`, not "no file".
	const outcome = resolveEffectiveCompilerOptions(absPath, read, parseTsconfigObject);
	return { options: outcome.kind === "ok" ? outcome.compilerOptions : null, chain: outcome.chain };
}

// ---- discovery --------------------------------------------------------------

const discovered = new Map<string, { at: number; files: string[] }>();

function gitTrackedConfigs(root: string): string[] | null {
	const r = spawnSync(
		"git",
		["-C", root, "ls-files", "-z", "--", ":(glob)**/tsconfig*.json", ":(glob)**/vitest*.config.*", ":(glob)**/vite.config.*"],
		{ encoding: "utf-8", timeout: GIT_TIMEOUT_MS },
	);
	if (r.status !== 0 || typeof r.stdout !== "string") return null;
	return r.stdout.split("\0").filter((rel) => rel.length > 0 && isConfigWaterLineName(rel));
}

function safeReaddir(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Breadth-first, bounded by depth and directory count; skips dot-dirs and bulk. */
function walkConfigs(root: string): string[] {
	const out: string[] = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	for (let visited = 0; visited < WALK_MAX_DIRS; visited += 1) {
		const next = queue.shift();
		if (!next) break;
		for (const entry of safeReaddir(next.dir).sort((a, b) => a.name.localeCompare(b.name))) {
			const abs = join(next.dir, entry.name);
			if (entry.isFile() && isConfigWaterLineName(entry.name)) out.push(relative(root, abs));
			const descend = entry.isDirectory() && next.depth < WALK_MAX_DEPTH;
			if (descend && !entry.name.startsWith(".") && !WALK_SKIP_DIRS.has(entry.name)) {
				queue.push({ dir: abs, depth: next.depth + 1 });
			}
		}
	}
	return out;
}

/** Tracked (or walked) config water-lines of a root, cached per DISCOVERY_TTL_MS. */
function deepConfigs(root: string, now: number): string[] {
	const hit = discovered.get(root);
	if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.files;
	const files = gitTrackedConfigs(root) ?? walkConfigs(root);
	discovered.set(root, { at: now, files });
	return files;
}

/** Root-level config water-lines, listed fresh every call (one readdir). */
function rootConfigs(root: string): string[] {
	return safeReaddir(root)
		.filter((e) => e.isFile() && isConfigWaterLineName(e.name))
		.map((e) => e.name);
}

/** Local extends targets of one tsconfig text, root-relative and inside root. */
function extendsTargets(root: string, rel: string, text: string | null): string[] {
	const parsed = text === null ? null : parseTsconfigObject(text);
	if (!isJsonObject(parsed)) return [];
	const raw = parsed.extends;
	const specs = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((s) => typeof s === "string") : [];
	const out: string[] = [];
	for (const spec of specs) {
		if (!(spec.startsWith("./") || spec.startsWith("../") || isAbsolute(spec))) continue;
		const abs = isAbsolute(spec) ? spec : resolve(dirname(join(root, rel)), spec);
		for (const candidate of abs.endsWith(".json") ? [abs] : [abs, `${abs}.json`]) {
			const r = relative(root, candidate);
			if (!r.startsWith("..") && !isAbsolute(r)) out.push(r);
		}
	}
	return out;
}

/** Forget cached discovery (tests; a root whose layout just changed). */
export function resetConfigDiscovery(): void {
	discovered.clear();
}

// ---- snapshot + detection ---------------------------------------------------

/**
 * Snapshot every config water-line under `root`: at most MAX_CONFIG_FILES
 * files, each read through the caller's byte-capped reader. Local extends
 * targets of the snapshotted tsconfigs fill the remaining slots.
 */
let captureFailures = 0;
/** Config snapshots whose capture threw (for example a failing `git ls-files`). */
export const configCaptureFailures = (): number => captureFailures;

/** `captureConfigWaterLines` for the PreToolUse path: a capture that throws
 *  must never reach the pipeline. It returns an empty snapshot (the call loses
 *  only the config comparison; the PreToolUse arms still judged it) and is
 *  counted, never propagated. */
export function captureConfigWaterLinesSafely(root: string, read: SnapshotReader): ConfigSnapshot {
	try {
		return captureConfigWaterLines(root, read);
	} catch {
		captureFailures++;
		return {};
	}
}

export function captureConfigWaterLines(root: string, read: SnapshotReader, now = Date.now()): ConfigSnapshot {
	const rels = [...new Set([...rootConfigs(root), ...deepConfigs(root, now)])].slice(0, MAX_CONFIG_FILES);
	const snap: Record<string, string | null> = {};
	for (const rel of rels) snap[rel] = read(join(root, rel));
	const pending = rels.filter((rel) => TSCONFIG_RE.test(rel));
	const visited = new Set<string>();
	for (let index = 0; index < pending.length; index++) {
		const rel = pending[index];
		if (rel === undefined) break;
		if (visited.has(rel)) continue;
		visited.add(rel);
		for (const target of extendsTargets(root, rel, snap[rel] ?? null)) {
			if (!(target in snap)) {
				if (Object.keys(snap).length >= MAX_CONFIG_FILES) continue;
				snap[target] = read(join(root, target));
			}
			if (!visited.has(target)) pending.push(target);
		}
	}
	return snap;
}

/** A reader serving one side's snapshotted bytes, the disk for anything else. */
function sideReader(root: string, side: ConfigSnapshot, read: SnapshotReader): SnapshotReader {
	return (absPath) => {
		const rel = relative(root, absPath);
		return rel in side ? (side[rel] ?? null) : read(absPath);
	};
}

interface SubjectVerdict {
	details: string[];
	/** Root-relative files on the subject's before- or after-side extends chain. */
	chain: string[];
}

/** Strictness loosenings of one tsconfig: effective (through extends) when
 *  both sides resolve, else its own compilerOptions. A deleted tsconfig
 *  compares against empty options — TypeScript's loose defaults. */
function tsconfigVerdict(root: string, rel: string, before: ConfigSnapshot, after: ConfigSnapshot, read: SnapshotReader): SubjectVerdict {
	const abs = join(root, rel);
	const b = effectiveOptions(abs, sideReader(root, before, read));
	const a = after[rel] === null ? { options: {}, chain: [abs] } : effectiveOptions(abs, sideReader(root, after, read));
	const chain = [...new Set([...b.chain, ...a.chain])].map((p) => relative(root, p));
	const details: string[] = [];
	if (b.options && a.options) {
		const wrap = (co: JsonObject): string => JSON.stringify({ compilerOptions: co });
		details.push(...strictnessFindings(rel, wrap(b.options), wrap(a.options)));
	}
	const beforeText = before[rel];
	const afterText = after[rel];
	// Own-text fallback, also for an EMPTY post-image: an existing parseable
	// tsconfig that no longer parses is a loosening (round 4, `tsconfig-parse`).
	if (details.length === 0 && beforeText && typeof afterText === "string") {
		details.push(...strictnessFindings(rel, beforeText, afterText));
	}
	return { details, chain };
}

function subjectVerdict(root: string, rel: string, before: ConfigSnapshot, after: ConfigSnapshot, read: SnapshotReader, warnings: string[]): SubjectVerdict {
	if (TSCONFIG_RE.test(rel)) return tsconfigVerdict(root, rel, before, after, read);
	const beforeText = before[rel];
	const afterText = after[rel];
	if (!isVitestConfigFile(rel) || !beforeText || beforeText === afterText) return { details: [], chain: [rel] };
	const verdict = decideVitestCoverageWaterLine(rel, beforeText, afterText ?? "");
	if (verdict.kind === "allow") {
		if (verdict.warning) warnings.push(`[interlinked:baseline-effect] NOT CHECKED: ${verdict.warning}`);
		return { details: [], chain: [rel] };
	}
	return { details: [verdict.reason], chain: [rel] };
}

/**
 * A changed extends target of any name (snapshotted because a tsconfig extends
 * it) that parsed before the call and no longer parses (round 4). A referencer's
 * after-side chain is then undecidable, so its own verdict cannot see this.
 */
function extendsTargetParseLoosening(rel: string, before: ConfigSnapshot, after: ConfigSnapshot, changed: ReadonlySet<string>): string | null {
	if (!changed.has(rel)) return null;
	const message = unparseablePostImage(before[rel], after[rel]);
	return message === null ? null : `[tsconfig-parse] ${message}`;
}

/**
 * Config files that got LOOSER between the pre-call snapshot and now.
 *
 * Fast path: when no snapshotted byte changed, nothing is parsed. A loosening
 * is attributed to the CHANGED files on the loosened subject's extends chain —
 * the subject itself, or the base file the call rewrote — so restoring the
 * reported files restores every config that inherits them, and an unrelated
 * config the same call tightened is left alone.
 */
export function detectConfigWaterLineLoosening(root: string, before: ConfigSnapshot, read: SnapshotReader, warnings: string[] = []): ConfigLoosening[] {
	const after: Record<string, string | null> = {};
	const changed = new Set<string>();
	for (const rel of Object.keys(before)) {
		after[rel] = read(join(root, rel));
		if (before[rel] !== null && after[rel] !== before[rel]) changed.add(rel);
	}
	if (changed.size === 0) return [];
	const reasons = new Map<string, string[]>();
	for (const rel of Object.keys(before).filter((r) => !isConfigWaterLineName(r))) {
		const parse = extendsTargetParseLoosening(rel, before, after, changed);
		if (parse !== null) reasons.set(rel, [parse]);
	}
	for (const rel of Object.keys(before)) {
		if (!isConfigWaterLineName(rel)) continue;
		const verdict = subjectVerdict(root, rel, before, after, read, warnings);
		if (verdict.details.length === 0) continue;
		for (const owner of verdict.chain.filter((c) => changed.has(c))) {
			const lines = owner === rel ? verdict.details : verdict.details.map((d) => `via ${rel}: ${d}`);
			reasons.set(owner, [...(reasons.get(owner) ?? []), ...lines]);
		}
	}
	return [...reasons.entries()].map(([file, details]) => ({
		file,
		beforeText: before[file] ?? "",
		afterText: after[file] ?? null,
		details,
	}));
}
