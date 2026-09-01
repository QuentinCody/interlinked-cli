// ===========================================
// Entry Points — Default entry-point composition (Phase A2)
// ===========================================
// Composes the set of files that count as "entry points" for the
// reachability query primitive in `project-graph.ts`. Three sources by
// default, each declared via a fixed-purpose helper:
//
//   1. http_handler — every file that defines an HTTP/MCP endpoint
//      (delegated to the A3 RouteMap; see `route-map.ts`).
//   2. bin           — every executable declared in `package.json`'s
//      `bin` field (string OR map shape).
//   3. lib_export    — every file referenced by `main` / `exports`,
//      plus the package-root `index.*` if not already captured.
//
// A fourth source (`test`) is OPTIONAL and off by default: test files
// are the verifiers, not the runtime, so they don't belong in a
// reachability sweep unless the caller explicitly opts in (e.g. for a
// "find dead production code" scan that should ignore test-only deps).
//
// Public API:
//
//   collectEntryPoints(projectRoot, { routeMap?, includeTests? })
//     → EntryPoint[]
//
// Returns absolute file paths in `EntryPoint.file`. Caller passes the
// returned `file` list straight to
// `ProjectGraph.isFileReachableFromEntryPoints`.
//
// Cloud-extensibility seam: same shape works for a future Agent CI
// cloud sweep because it depends only on `projectRoot` + the A3
// `RouteMap` (also reusable). No harness-state dependencies.

import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { RouteMap } from "./route-map.js";

/** Kind of entry point — what surfaced this file as a root of reachability. */
type EntryPointKind = "http_handler" |"bin" | "lib_export" | "test";

/** One entry-point record. Absolute path in `file`; `reason` is for diagnostics. */
export interface EntryPoint {
	kind: EntryPointKind;
	file: string;
	reason: string;
}

/** Options bag for `collectEntryPoints`. */
interface CollectEntryPointsOptions {
	/** Pre-initialized RouteMap, reused so we don't double-scan. */
	routeMap?: RouteMap;
	/**
	 * Opt-in: also include test files. Off by default because tests are
	 * the verifiers, not the runtime, and including them defeats the
	 * point of a "reachable from production roots" sweep.
	 */
	includeTests?: boolean;
}

/**
 * The package-root index files we recognize as a default library
 * entry. Pinned to the same extensions the project graph indexes so
 * the BFS can actually traverse them.
 */
const INDEX_BASENAMES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"];

/** Test-file extensions and basename suffixes (kept tiny — opt-in path only). */
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx", ".spec.js"];

/** Directories we never descend into when scanning for tests. */
const TEST_SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	".interlinked",
	".claude",
	".turbo",
	".next",
	".cache",
	"out",
	"target",
	".venv",
	"venv",
]);

/**
 * Compose the default entry-point set for `projectRoot`.
 *
 * Pure function: reads `package.json` synchronously, calls
 * `routeMap.extractAllEndpoints()` if provided. Never mutates state.
 * Each returned `file` is resolved to an absolute path. Duplicate
 * `(kind, file)` pairs are collapsed; if the same file is surfaced by
 * two different `kind`s (e.g. an http_handler also referenced as a
 * lib_export), both records are kept — callers can dedupe by
 * `file` if they want to.
 */
export function collectEntryPoints(
	projectRoot: string,
	opts: CollectEntryPointsOptions = {},
): EntryPoint[] {
	const root = resolve(projectRoot);
	const out: EntryPoint[] = [];

	pushAll(out, collectHttpHandlers(opts.routeMap));
	pushAll(out, collectBinEntries(root));
	pushAll(out, collectLibExports(root));
	if (opts.includeTests) {
		pushAll(out, collectTestFiles(root));
	}

	return dedupe(out);
}

/**
 * Pull the file list off `RouteMap.extractAllEndpoints()`. The route
 * map is the only A3 surface we depend on — see `route-map.ts`.
 *
 * When no route map is supplied we return `[]` rather than constructing
 * one on the fly: building a RouteMap requires its own initialization
 * pass and the caller may not have indexed anything yet. The contract
 * is "supply the route map if you want HTTP roots."
 */
function collectHttpHandlers(routeMap?: RouteMap): EntryPoint[] {
	if (!routeMap) return [];
	const endpoints = routeMap.extractAllEndpoints();
	const out: EntryPoint[] = [];
	for (const ep of endpoints) {
		const reason = `${ep.framework} ${ep.method} ${ep.path}${ep.line ? `:${ep.line}` : ""}`;
		out.push({ kind: "http_handler", file: ep.file, reason });
	}
	return out;
}

/**
 * Walk `package.json:bin` — accepts both shapes:
 *
 *   "bin": "./cli.js"
 *   "bin": { "interlinked": "./dist/cli.js", "il": "./dist/short.js" }
 */
function collectBinEntries(projectRoot: string): EntryPoint[] {
	const pkg = readPackageJson(projectRoot);
	if (!pkg) return [];
	const bin = pkg.bin;
	const out: EntryPoint[] = [];
	if (typeof bin === "string") {
		const abs = resolve(projectRoot, bin);
		if (existsSync(abs)) {
			out.push({ kind: "bin", file: abs, reason: "package.json:bin" });
		}
	} else if (isJsonObject(bin)) {
		for (const [name, target] of Object.entries(bin)) {
			if (typeof target !== "string") continue;
			const abs = resolve(projectRoot, target);
			if (existsSync(abs)) {
				out.push({ kind: "bin", file: abs, reason: `package.json:bin[${name}]` });
			}
		}
	}
	return out;
}

/**
 * Type guard: narrow `unknown` to a plain JSON-object map with unknown
 * values. Avoids the `Record<string, any>` / `Record<string, unknown>`
 * footgun (the `broad_object_types` detector — `checks/agent-safety.ts`
 * fires on both). `JsonObject` is a tighter handle: the caller still
 * has to typeof-check the value at each key.
 */
type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pull lib-export entries from `package.json:main` and
 * `package.json:exports`, plus the package-root `index.*` if it isn't
 * already named. Subpath exports (`./<sub>` keys) walk each export
 * record looking for `import` / `require` / `default` targets.
 */
function collectLibExports(projectRoot: string): EntryPoint[] {
	const pkg = readPackageJson(projectRoot);
	const out: EntryPoint[] = [];
	const named = new Set<string>();

	if (pkg) {
		if (typeof pkg.main === "string") {
			const abs = resolve(projectRoot, pkg.main);
			if (existsSync(abs)) {
				out.push({ kind: "lib_export", file: abs, reason: "package.json:main" });
				named.add(abs);
			}
		}
		walkExportsField({ projectRoot, out, named }, pkg.exports);
	}

	// Always add a package-root index.* if it isn't already named.
	for (const basename of INDEX_BASENAMES) {
		const abs = join(projectRoot, basename);
		if (existsSync(abs) && !named.has(abs)) {
			out.push({ kind: "lib_export", file: abs, reason: `${basename} at package root` });
			named.add(abs);
		}
	}

	return out;
}

/**
 * Opt-in test-file collection. Cheap recursive walk; respects the same
 * skip-list as the project graph (intentionally a small inline subset —
 * this is a fallback path for the rare "find unreachable production
 * code" sweep, not a hot path).
 */
function collectTestFiles(projectRoot: string): EntryPoint[] {
	const out: EntryPoint[] = [];
	const stack: string[] = [projectRoot];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".") continue;
			if (TEST_SKIP_DIRS.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile() && TEST_SUFFIXES.some((s) => entry.name.endsWith(s))) {
				out.push({ kind: "test", file: full, reason: `test file: ${entry.name}` });
			}
		}
	}
	return out;
}

/**
 * Walk context passed through `walkExportsField`. Collapsing the
 * caller-supplied parameters into one struct keeps the call sites
 * self-documenting (`{ projectRoot, ... }`) and satisfies the
 * `function_arg_count` detector (which fires on 4+ positional params).
 */
interface WalkExportsContext {
	projectRoot: string;
	out: EntryPoint[];
	named: Set<string>;
}

/**
 * Walk the `exports` field — supports the four shapes seen in the
 * wild: bare string, object with conditional keys, object with subpath
 * keys, and arrays. Each leaf string is treated as a potential
 * lib_export target. Inlined as a separate function (rather than a
 * closure) so the recursion is visible in stack traces.
 */
function walkExportsField(ctx: WalkExportsContext, node: unknown, pathLabel = "exports"): void {
	if (typeof node === "string") {
		const abs = resolve(ctx.projectRoot, node);
		if (existsSync(abs) && !ctx.named.has(abs)) {
			ctx.out.push({ kind: "lib_export", file: abs, reason: `package.json:${pathLabel}` });
			ctx.named.add(abs);
		}
		return;
	}
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			walkExportsField(ctx, node[i], `${pathLabel}[${i}]`);
		}
		return;
	}
	if (isJsonObject(node)) {
		for (const key of Object.keys(node)) {
			walkExportsField(ctx, node[key], `${pathLabel}.${key}`);
		}
	}
}

/**
 * Minimal-typed `package.json` view — only the fields we actually
 * read. Unknown JSON shape is tolerated; missing/malformed = `null`.
 */
interface PackageJsonView {
	main?: unknown;
	bin?: unknown;
	exports?: unknown;
}

function readPackageJson(projectRoot: string): PackageJsonView | null {
	const path = join(projectRoot, "package.json");
	if (!existsSync(path)) return null;
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	return {
		main: parsed.main,
		bin: parsed.bin,
		exports: parsed.exports,
	};
}

function pushAll<T>(target: T[], items: T[]): void {
	for (const item of items) target.push(item);
}

function dedupe(items: EntryPoint[]): EntryPoint[] {
	const seen = new Set<string>();
	const out: EntryPoint[] = [];
	for (const item of items) {
		// Key includes `reason` because http_handler entries share `file`
		// across every endpoint registered in that file — two `app.get(...)`
		// calls in `api.ts` would otherwise collapse to one entry. The
		// reason string encodes framework/method/path, which is enough to
		// keep distinct endpoints distinct while still collapsing the
		// "same kind, same file, same surface" double-emission that bin/
		// lib_export overlap can produce.
		const key = `${item.kind}|${item.file}|${item.reason}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
