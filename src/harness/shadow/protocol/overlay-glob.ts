// ===========================================
// Shadow protocol v1 — gitwildmatch-v1: grammar, compilation, bounded matching
// ===========================================
// The grammar this module implements is documented in `overlay-manifest.ts`,
// which owns the manifest that carries the rules and re-exports the entry
// points below. It lives in its own module because the matcher is a small
// machine with one hard requirement of its own:
//
//   THE COST IS BOUNDED BY CONSTRUCTION, NOT BY TASTE IN PATTERNS.
//
// The first implementation compiled each pattern to a regex, which turns every
// "*" into an independent backtracking `[^/]*`. The VALID 41-byte pattern
// `("*a" x 20) + "b"` against 40 "a" characters then ran for minutes — and the
// overlay manifest is agent-writable while this matcher sits on the hook path,
// so that one line was a local denial of service. The regex also THREW on
// `[z-a]`, a pattern its own validator accepted.
//
// So a pattern compiles to a TOKEN PROGRAM and matching is an NFA sweep: one
// forward pass per input character over the set of reachable token positions.
// Each pattern segment costs O(its tokens x the path characters), so the whole
// match is O(pattern x path) and never backtracks. Compilation is separate and
// cached, so a caller with many candidate paths pays it per RULE, not per path.

import { isWellFormedString } from "../../mutation/protocol-v3/canonical.js";
import type { Reason } from "./field-checks.js";
import { MAX_PATH_BYTES, MAX_PATH_COMPONENT_BYTES } from "./path-rules.js";

// ── validation ─────────────────────────────────────────────────────────────

/** null when the pattern is inside the documented subset, else the reason. */
export function checkGitWildmatchPattern(value: unknown, where: string): Reason {
	if (typeof value !== "string" || value.length === 0) return `${where} must be a non-empty pattern`;
	if (value.includes("\0")) return `${where} must not contain a NUL byte`;
	if (value.includes("\\")) return `${where} must use POSIX separators, not backslashes`;
	// Well-formedness is checked BEFORE compilation: a lone surrogate has no
	// UTF-8 encoding, so two machines could never agree on which bytes such a
	// pattern matches.
	if (!isWellFormedString(value)) return `${where} must be well-formed Unicode (no lone surrogates)`;
	if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) return `${where} exceeds ${MAX_PATH_BYTES} bytes`;
	const segments = patternSegments(value);
	if (segments.length === 0) return `${where} must name at least one segment`;
	return firstSegmentReason(segments, where);
}

function firstSegmentReason(segments: readonly string[], where: string): Reason {
	for (const segment of segments) {
		const reason = segmentReason(segment, where);
		if (reason !== null) return reason;
	}
	return null;
}

function segmentReason(segment: string, where: string): Reason {
	if (segment.length === 0) return `${where} must not contain an empty segment`;
	if (segment === "." || segment === "..") return `${where} must not contain a "${segment}" segment`;
	if (segment === "**") return null;
	if (Buffer.byteLength(segment, "utf8") > MAX_PATH_COMPONENT_BYTES) {
		return `${where} has a component over ${MAX_PATH_COMPONENT_BYTES} bytes`;
	}
	return tokenizeSegment(segment) === null ? `${where} has an invalid character class` : null;
}

/** The pattern's segments with the optional anchor and directory slashes
 *  removed — the shape both validation and compilation reason about. */
export function patternSegments(pattern: string): string[] {
	const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
	const stripped = core.startsWith("/") ? core.slice(1) : core;
	return stripped.length === 0 ? [] : stripped.split("/");
}

/** A leading "/" is redundant when the pattern is anchored anyway (it carries
 *  another "/"); on a bare name the leading "/" IS the anchor, so it stays.
 *  This is the normalization duplicate rejection compares against. */
export function normalizeGitWildmatchPattern(pattern: string): string {
	if (!pattern.startsWith("/")) return pattern;
	const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
	return core.slice(1).includes("/") ? pattern.slice(1) : pattern;
}

// ── compilation ────────────────────────────────────────────────────────────

interface GlobClassRangeV1 {
	readonly from: number;
	readonly to: number;
}
type GlobTokenV1 =
	| { readonly kind: "literal"; readonly code: number }
	| { readonly kind: "any" }
	| { readonly kind: "star" }
	| { readonly kind: "class"; readonly negated: boolean; readonly ranges: readonly GlobClassRangeV1[] };
type GlobSegmentV1 =
	| { readonly kind: "doublestar" }
	| { readonly kind: "tokens"; readonly tokens: readonly GlobTokenV1[] };

/** One pattern compiled once. Public so a caller holding many candidate paths
 *  pays compilation per RULE, never per path. */
export interface CompiledGitWildmatchV1 {
	readonly segments: readonly GlobSegmentV1[];
	readonly anchored: boolean;
	readonly directoryPrefix: boolean;
}

/** Class items as code-unit ranges. An out-of-order range (`[z-a]`) is
 *  REJECTED at validation rather than compiled into a class that matches
 *  nothing: a rule that can never match any path is a typo, and a manifest
 *  that silently carries one is a file the author believes travels and that
 *  does not. (The old regex compiler threw an uncaught SyntaxError on it.) */
function hasImpossibleRange(ranges: readonly GlobClassRangeV1[]): boolean {
	return ranges.some((range) => range.from > range.to);
}

function classRanges(body: string): GlobClassRangeV1[] {
	const ranges: GlobClassRangeV1[] = [];
	let index = 0;
	while (index < body.length) {
		const from = body.charCodeAt(index);
		if (index + 2 < body.length && body.charAt(index + 1) === "-") {
			ranges.push({ from, to: body.charCodeAt(index + 2) });
			index += 3;
			continue;
		}
		ranges.push({ from, to: from });
		index += 1;
	}
	return ranges;
}

function parseClass(segment: string, start: number): { token: GlobTokenV1; next: number } | null {
	const close = segment.indexOf("]", start + 1);
	if (close === -1) return null;
	const raw = segment.slice(start + 1, close);
	const negated = raw.startsWith("!") || raw.startsWith("^");
	const body = negated ? raw.slice(1) : raw;
	if (body.length === 0) return null;
	const ranges = classRanges(body);
	if (hasImpossibleRange(ranges)) return null;
	return { token: { kind: "class", negated, ranges }, next: close + 1 };
}

function atomToken(char: string, code: number): GlobTokenV1 {
	if (char === "*") return { kind: "star" };
	if (char === "?") return { kind: "any" };
	return { kind: "literal", code };
}

/** The token program for one non-"**" segment, or null when the segment is
 *  malformed (an unterminated or empty character class). A segment never
 *  contains a "/", so no token has to exclude one. */
function tokenizeSegment(segment: string): GlobTokenV1[] | null {
	const tokens: GlobTokenV1[] = [];
	let index = 0;
	while (index < segment.length) {
		const char = segment.charAt(index);
		if (char === "[") {
			const parsed = parseClass(segment, index);
			if (parsed === null) return null;
			tokens.push(parsed.token);
			index = parsed.next;
			continue;
		}
		tokens.push(atomToken(char, segment.charCodeAt(index)));
		index += 1;
	}
	return tokens;
}

/** Compile once. Null when the pattern is outside the documented subset — an
 *  invalid rule must never widen the set of paths that travel. */
export function compileGitWildmatchV1(pattern: string): CompiledGitWildmatchV1 | null {
	if (checkGitWildmatchPattern(pattern, "pattern") !== null) return null;
	const segments: GlobSegmentV1[] = [];
	for (const raw of patternSegments(pattern)) {
		if (raw === "**") {
			segments.push({ kind: "doublestar" });
			continue;
		}
		const tokens = tokenizeSegment(raw);
		if (tokens === null) return null;
		segments.push({ kind: "tokens", tokens });
	}
	const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
	// Anchored when the pattern carries any "/"; otherwise it is a basename
	// rule and may start at any segment boundary.
	return { segments, anchored: core.includes("/"), directoryPrefix: pattern.endsWith("/") };
}

// ── matching ───────────────────────────────────────────────────────────────

function tokenMatches(token: GlobTokenV1, code: number): boolean {
	if (token.kind === "literal") return token.code === code;
	if (token.kind === "any") return true;
	if (token.kind !== "class") return false; // "star" is advanced by the caller
	const inside = token.ranges.some((range) => range.from <= code && code <= range.to);
	return token.negated ? !inside : inside;
}

/** A "*" may consume nothing, so every reachable star position also reaches
 *  the position after it. Forward and in place: the relation only ever points
 *  right, so one pass is already a fixpoint. */
function starClosure(tokens: readonly GlobTokenV1[], reach: boolean[]): void {
	for (let index = 0; index < tokens.length; index += 1) {
		if (reach[index] === true && tokens[index]?.kind === "star") reach[index + 1] = true;
	}
}

function advanceTokens(tokens: readonly GlobTokenV1[], reach: readonly boolean[], next: boolean[], code: number): void {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (reach[index] !== true || token === undefined) continue;
		if (token.kind === "star") next[index] = true;
		else if (tokenMatches(token, code)) next[index + 1] = true;
	}
}

/** One path segment against one segment program. Each character advances the
 *  whole reachable set exactly once: O(tokens x characters), no backtracking,
 *  whatever the pattern. */
function matchTokens(tokens: readonly GlobTokenV1[], text: string): boolean {
	let reach = new Array<boolean>(tokens.length + 1).fill(false);
	reach[0] = true;
	starClosure(tokens, reach);
	for (let at = 0; at < text.length; at += 1) {
		const next = new Array<boolean>(tokens.length + 1).fill(false);
		advanceTokens(tokens, reach, next, text.charCodeAt(at));
		starClosure(tokens, next);
		reach = next;
		if (!reach.includes(true)) return false;
	}
	return reach[tokens.length] === true;
}

interface SplitPathV1 {
	readonly segments: readonly string[];
	/** Character index where each segment starts — the tail predicates measure
	 *  the unconsumed remainder without slicing it. */
	readonly offsets: readonly number[];
}

function splitPath(path: string): SplitPathV1 {
	const segments = path.split("/");
	const offsets: number[] = [];
	let at = 0;
	for (const segment of segments) {
		offsets.push(at);
		at += segment.length + 1;
	}
	return { segments, offsets };
}

/** "**" between segments, and the basename head: zero or more WHOLE non-empty
 *  segments, each followed by a "/". Forward and in place, because the
 *  relation is transitive left to right. */
function crossSegments(segments: readonly string[], reach: boolean[]): void {
	for (let index = 0; index + 1 < segments.length; index += 1) {
		if (reach[index] === true && segments[index] !== "") reach[index + 1] = true;
	}
}

function stepSegment(segment: GlobSegmentV1, path: SplitPathV1, reach: boolean[]): boolean[] {
	if (segment.kind === "doublestar") {
		crossSegments(path.segments, reach);
		return reach;
	}
	const next = new Array<boolean>(reach.length).fill(false);
	for (let index = 0; index < path.segments.length; index += 1) {
		if (reach[index] !== true) continue;
		if (matchTokens(segment.tokens, path.segments[index] ?? "")) next[index + 1] = true;
	}
	return next;
}

/** How the path must END. "end": the pattern consumed all of it. "rest": a
 *  trailing "**" or a trailing "/" — a separator plus at least one more
 *  character. "rest-with-separator": both at once, which needs a "/" carrying
 *  a non-empty side each way. */
type GlobTailV1 = "end" | "rest" | "rest-with-separator";

function tailOf(compiled: CompiledGitWildmatchV1, trailingDoubleStar: boolean): GlobTailV1 {
	if (trailingDoubleStar && compiled.directoryPrefix) return "rest-with-separator";
	return trailingDoubleStar || compiled.directoryPrefix ? "rest" : "end";
}

function tailAccepts(tail: GlobTailV1, path: string, start: number): boolean {
	if (tail === "rest") return start < path.length;
	const slash = path.indexOf("/", start + 1);
	return slash !== -1 && slash < path.length - 1;
}

function accepts(tail: GlobTailV1, path: string, split: SplitPathV1, reach: readonly boolean[]): boolean {
	if (tail === "end") return reach[split.segments.length] === true;
	for (let index = 0; index < split.segments.length; index += 1) {
		if (reach[index] === true && tailAccepts(tail, path, split.offsets[index] ?? 0)) return true;
	}
	return false;
}

/** Match a pre-compiled pattern. The segment sweep uses the same reachable-set
 *  idea as `matchTokens`, so the whole matcher stays linear in the two input
 *  sizes and holds no state between calls. */
export function matchCompiledGitWildmatchV1(compiled: CompiledGitWildmatchV1, path: string): boolean {
	const split = splitPath(path);
	const trailingDoubleStar = compiled.segments[compiled.segments.length - 1]?.kind === "doublestar";
	const body = trailingDoubleStar ? compiled.segments.slice(0, -1) : compiled.segments;
	let reach = new Array<boolean>(split.segments.length + 1).fill(false);
	reach[0] = true;
	if (!compiled.anchored) crossSegments(split.segments, reach);
	for (const segment of body) {
		reach = stepSegment(segment, split, reach);
		if (!reach.includes(true)) return false;
	}
	return accepts(tailOf(compiled, trailingDoubleStar), path, split, reach);
}

// A full manifest (1024 rules) plus the deny ruleset fits, so a large manifest
// never thrashes the cache. Compilation is a linear parse either way.
const MAX_COMPILED_CACHE = 2048;
const compiledCache = new Map<string, CompiledGitWildmatchV1 | null>();

function compiledPattern(pattern: string): CompiledGitWildmatchV1 | null {
	const cached = compiledCache.get(pattern);
	if (cached !== undefined) return cached;
	const compiled = compileGitWildmatchV1(pattern);
	if (compiledCache.size >= MAX_COMPILED_CACHE) compiledCache.clear();
	compiledCache.set(pattern, compiled);
	return compiled;
}

/** True when `path` matches `pattern` under gitwildmatch-v1. An invalid
 *  pattern matches NOTHING — a rule the grammar refuses must never widen the
 *  set of paths that travel. */
export function matchesGitWildmatchV1(pattern: string, path: string): boolean {
	const compiled = compiledPattern(pattern);
	return compiled !== null && matchCompiledGitWildmatchV1(compiled, path);
}
