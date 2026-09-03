// ===========================================
// Go invocation policy — package scope, build tags, environment parity
// ===========================================
// One place that decides HOW the Go toolchain is invoked, shared by every Go
// surface (`go build` and `golangci-lint` in ./go.ts, `go test` in
// quality-checks/test-dispatchers.ts).
//
// Why it exists: a single `.go` edit used to spawn three project-wide Go
// compilations with three DIFFERENT loader configurations — `go build ./...`,
// `go test -count=1 ./<pkg>`, `golangci-lint run ./...` — so each populated a
// distinct build-cache key set and the first run of each re-did work the
// others had just done. Nothing threaded GOFLAGS/-tags, and the daemon
// inherits whatever environment started it, so GOCACHE could differ from the
// user's shell entirely.
//
// Three levers, all pure and independently testable:
//   1. package scope   — narrow ONLY where the wider output is discarded
//   2. build tags      — same tag set for every invocation
//   3. environment     — same GOCACHE/GOFLAGS for every invocation

import { dirname, isAbsolute, relative, sep } from "node:path";
import type { CheckScope } from "../types.js";

/** The Go pattern meaning "every package in this module". */
export const WHOLE_MODULE_PATTERN = "./...";

/**
 * Relative Go package argument for `pkgDir` under `projectRoot`, or `null`
 * when `pkgDir` sits outside the root (no relative package pattern can name
 * it; the caller decides the fallback).
 */
export function goPackageArg(target: { pkgDir: string; projectRoot: string }): string | null {
	const rel = relative(target.projectRoot, target.pkgDir);
	if (rel === "") return ".";
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return `./${rel.split(sep).join("/")}`;
}

/**
 * Package pattern for a project-wide Go tool (`go build`, `golangci-lint`).
 *
 * Narrows to the edited file's package ONLY when the scope is file-mode AND
 * `filterToFile` is set — precisely the case where every finding outside that
 * file is discarded anyway, so the wider compile buys nothing but latency.
 * Every other scope keeps {@link WHOLE_MODULE_PATTERN}, so project-wide
 * verify runs are unchanged.
 */
export function goPackagePattern(scope: CheckScope): string {
	if (scope.mode !== "file" || !scope.targetFile || !scope.filterToFile) {
		return WHOLE_MODULE_PATTERN;
	}
	return (
		goPackageArg({ pkgDir: dirname(scope.targetFile), projectRoot: scope.projectRoot }) ??
		WHOLE_MODULE_PATTERN
	);
}

/** `-tags` occurrences inside a GOFLAGS-style string. Later ones win, as in go. */
const TAGS_FLAG = /(?:^|\s)-{1,2}tags(?:=|\s+)(\S+)/g;

/** Build tags declared by a GOFLAGS-style string (`-tags=a,b`, `--tags a,b`). */
export function parseGoBuildTags(goflags: string | undefined): string[] {
	if (!goflags) return [];
	let raw: string | undefined;
	for (const match of goflags.matchAll(TAGS_FLAG)) raw = match[1] ?? raw;
	if (!raw) return [];
	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

/** `go` spelling of a build-tag set (empty set → no argv at all). */
export function goBuildTagArgs(tags: readonly string[]): string[] {
	return tags.length > 0 ? [`-tags=${tags.join(",")}`] : [];
}

/**
 * `golangci-lint` spelling of a build-tag set. golangci-lint does NOT read
 * `-tags` out of GOFLAGS, so without this its loader type-checks a different
 * file set than `go build` did — different results AND a different cache.
 */
export function golangciBuildTagArgs(tags: readonly string[]): string[] {
	return tags.length > 0 ? [`--build-tags=${tags.join(",")}`] : [];
}

function trimmed(value: string | undefined): string | undefined {
	const out = value?.trim();
	return out ? out : undefined;
}

/**
 * The environment every Go invocation gets, so all of them share one build
 * cache and one loader configuration.
 *
 * The daemon cannot observe the invoking shell, so the two knobs are explicit:
 * `INTERLINKED_GOFLAGS` is appended to any inherited `GOFLAGS`, and
 * `INTERLINKED_GOCACHE` replaces an inherited `GOCACHE`. Absent both, the
 * inherited environment is passed through unchanged — the value here is that
 * it is passed EXPLICITLY and identically to each tool.
 */
export function resolveGoEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const resolved: NodeJS.ProcessEnv = { ...env };
	const flags = [trimmed(env.GOFLAGS), trimmed(env.INTERLINKED_GOFLAGS)].filter(
		(part): part is string => part !== undefined,
	);
	if (flags.length > 0) resolved.GOFLAGS = flags.join(" ");
	const cache = trimmed(env.INTERLINKED_GOCACHE);
	if (cache) resolved.GOCACHE = cache;
	return resolved;
}

/** Build tags for this environment, read through {@link resolveGoEnv}. */
export function goToolTags(env: NodeJS.ProcessEnv): string[] {
	return parseGoBuildTags(resolveGoEnv(env).GOFLAGS);
}
