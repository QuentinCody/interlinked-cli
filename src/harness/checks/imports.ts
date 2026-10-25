// Import policy checks — module-graph hygiene.
// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.3).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

const BARREL_LOCAL_SPECIFIERS = new Set([
	".",
	"./",
	"./index",
	"./index.js",
	"./index.ts",
	"./index.mjs",
	"./index.cjs",
	"./index.jsx",
	"./index.tsx",
]);

/** Sibling index candidates, in the order Node/TS resolve a directory import. */
const INDEX_CANDIDATES = ["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.jsx", "index.mjs", "index.cjs"];

/** Resolve `<dir>/index.*` to the first candidate on disk, or `null`. */
function siblingIndexPath(dir: string): string | null {
	for (const candidate of INDEX_CANDIDATES) {
		const full = join(dir, candidate);
		if (existsSync(full)) return full;
	}
	return null;
}

/**
 * Module edges in one file: `from "x"`, `import "x"`, `import("x")`,
 * `require("x")`. Comments are NOT stripped — a commented edge errs toward
 * "reaches", the firing direction.
 */
const MODULE_EDGE_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Path-alias prefixes (`@/x`, `~/x`, `#x`, `$lib/x`). A scoped package `@scope/x` is not one. */
const ALIAS_PREFIX_RE = /^(?:@\/|~\/?|#\/?|\$)/;

/** Strip a JS/TS extension (`foo.js` → `foo`). */
function stripJsExt(path: string): string {
	const ext = extname(path);
	return JS_TS_EXTS.has(ext) ? path.slice(0, -ext.length) : path;
}

/** Max files the barrel walk reads — a barrel graph larger than this is treated as reaching. */
const BARREL_WALK_LIMIT = 64;

/** Max ancestor directories tried when anchoring an alias specifier on disk. */
const ALIAS_ANCHOR_DEPTH = 12;

type BarrelReach = "reaches" | "unreachable" | "unknown";

interface BarrelWalk {
	/** Absolute barrel directory. The walk follows edges only inside this subtree. */
	readonly scope: string;
	/** Absolute importer path, JS/TS extension stripped. */
	readonly importer: string;
	readonly importerStem: string;
	readonly seen: Set<string>;
	readonly queue: string[];
}

function inScope(scope: string, path: string): boolean {
	return path === scope || path.startsWith(`${scope}${sep}`);
}

/** The on-disk module a target names (file, extension swap, or directory index), or `null`. */
function resolveModuleFile(target: string): string | null {
	if (JS_TS_EXTS.has(extname(target)) && existsSync(target)) return target;
	const bare = stripJsExt(target);
	for (const ext of JS_TS_EXTS) {
		if (existsSync(`${bare}${ext}`)) return `${bare}${ext}`;
	}
	return siblingIndexPath(target);
}

/**
 * Absolute paths one specifier can name. A relative specifier resolves
 * against its file. An alias (`@/components/foo`) has no tsconfig here, so it
 * is anchored at each ancestor of the scope; only anchorings that land inside
 * the scope are kept. A bare package name yields nothing.
 */
function edgeTargets(fromDir: string, spec: string, scope: string): string[] {
	if (spec.startsWith(".")) return [resolve(fromDir, spec)];
	if (!ALIAS_PREFIX_RE.test(spec)) return [];
	const rest = spec.replace(ALIAS_PREFIX_RE, "");
	const targets: string[] = [];
	let anchor = scope;
	for (let depth = 0; depth < ALIAS_ANCHOR_DEPTH; depth++) {
		const target = resolve(anchor, rest);
		if (inScope(scope, target)) targets.push(target);
		const parent = dirname(anchor);
		if (parent === anchor) break;
		anchor = parent;
	}
	return targets;
}

/** Last path segment of a non-relative specifier, ignoring a JS/TS extension and a trailing `/index`. */
function lastSpecifierSegment(spec: string): string {
	const segments = stripJsExt(spec).replace(/\/index$/, "").split("/");
	return nonNull(segments[segments.length - 1]);
}

/** Follow one edge: `true` when it names the importer, else enqueue its in-scope module. */
function visitEdge(walk: BarrelWalk, fromDir: string, spec: string): boolean {
	// An unresolvable path-shaped alias (`@components/foo`) that names the
	// importer's stem is treated as reaching it — the firing direction.
	if (!spec.startsWith(".") && spec.includes("/") && lastSpecifierSegment(spec) === walk.importerStem) return true;
	for (const target of edgeTargets(fromDir, spec, walk.scope)) {
		// Covers an unsaved importer and a `.js` specifier for a `.ts` file.
		if (stripJsExt(target) === walk.importer) return true;
		if (!inScope(walk.scope, target)) continue;
		const file = resolveModuleFile(target);
		if (file === null || walk.seen.has(file)) continue;
		walk.seen.add(file);
		walk.queue.push(file);
	}
	return false;
}

function readTextOrNull(file: string): string | null {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Does the sibling barrel reach the importing file, transitively, through
 * module edges that stay inside the barrel's directory subtree (subdirectory
 * barrels and `../` edges back into the scope included; path aliases
 * anchored on disk)? `"unknown"` when no `index.*` exists on disk or one
 * cannot be read — the caller keeps the historical firing behavior then, so
 * an unsaved barrel never silences the finding.
 *
 * Found 2026-10-21 by the cross-repo falsifier: date-fns' one-function-per-
 * directory layout makes `index.ts` the IMPLEMENTATION, whose edges all leave
 * the directory (`../addDays/index.ts`), so `./index` there is not a barrel
 * and no init cycle exists. The scope bound is what keeps that layout quiet:
 * following `../` edges out of the subtree would walk the whole package.
 */
function barrelReach(filePath: string): BarrelReach {
	const scope = resolve(dirname(filePath));
	const start = siblingIndexPath(scope);
	if (start === null) return "unknown";
	const importer = stripJsExt(resolve(filePath));
	const walk: BarrelWalk = { scope, importer, importerStem: basename(importer), seen: new Set([start]), queue: [start] };
	while (walk.queue.length > 0) {
		if (walk.seen.size > BARREL_WALK_LIMIT) return "reaches";
		const file = nonNull(walk.queue.shift());
		const text = readTextOrNull(file);
		if (text === null) return "unknown";
		for (const match of text.matchAll(MODULE_EDGE_RE)) {
			if (visitEdge(walk, dirname(file), nonNull(match[1]))) return "reaches";
		}
	}
	return "unreachable";
}

/**
 * A bare `test.<ext>` / `spec.<ext>` with test-runner evidence (date-fns
 * `<fn>/test.ts` beside `<fn>/index.ts`). Local to this detector on purpose:
 * the shared classifiers must not call every bare `spec.ts` a test (this
 * repo's product `src/commands/spec.ts`), and the caller still fires when
 * the barrel reaches the file.
 */
const BARE_TEST_STEMS = new Set(["test", "spec"]);
const TEST_RUNNER_EVIDENCE_RE =
	/\bfrom\s*['"](?:vitest|@jest\/globals|node:test|bun:test|mocha|ava|uvu|tap)['"]|^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/m;

function isBareTestModule(stem: string, content: string): boolean {
	return BARE_TEST_STEMS.has(stem) && TEST_RUNNER_EVIDENCE_RE.test(content);
}

/**
 * `import type X from` / `import type { … } from` / `export type … from`, or
 * a brace clause whose every specifier is `type X` — erased at emit, so no
 * runtime module-init edge exists. A mixed clause (`{ type A, b }`) still
 * carries a value import, and so does a default binding NAMED `type`
 * (`import type from "./index"`, `import type, { x } from "./index"`).
 */
function isTypeOnlyImportLine(originalLine: string): boolean {
	if (/^\s*(?:import|export)\s+type\b(?!\s*(?:,|from\b))/.test(originalLine)) return true;
	const clause = originalLine.match(/^\s*(?:import|export)\s*\{([^}]*)\}\s*from\b/);
	if (!clause) return false;
	const specifiers = nonNull(clause[1])
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return specifiers.length > 0 && specifiers.every((s) => /^type\s+\S/.test(s));
}

const _pkgNameCache = new Map<string, string | null>();

/** Resolve the `name` field of the nearest package.json walking up from `startDir`. */
function nearestPackageName(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 6; i++) {
		const cached = _pkgNameCache.get(dir);
		if (cached !== undefined) return cached;
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
				const name = isJsonObject(pkg) && typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : null;
				_pkgNameCache.set(dir, name);
				return name;
			} catch {
				_pkgNameCache.set(dir, null);
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Extract the specifier out of an `import ... from <spec>` / `export ... from
 * <spec>` line, or `null` if the line isn't that shape.
 *
 * Strings get stripped to empty `""` for comment-filtering, so the leading-
 * keyword check runs on the stripped line while specifier extraction reads
 * from the original.
 */
function extractImportSpecifier(strippedLine: string, originalLine: string): string | null {
	const strippedTrimmed = strippedLine.trim();
	if (!/^(?:import|export)\b/.test(strippedTrimmed)) return null;
	const fromMatch = originalLine.match(/\bfrom\s+['"]([^'"]+)['"]/);
	if (!fromMatch) return null;
	return nonNull(fromMatch[1]);
}

/** Build the finding text for one specifier, or `null` if it isn't a barrel/own-package import. */
function matchBarrelSpecifier(
	specifier: string,
	originalLine: string,
	ownPackageName: string | null,
	localBarrelReach: () => BarrelReach,
): string | null {
	if (isTypeOnlyImportLine(originalLine)) return null;
	if (BARREL_LOCAL_SPECIFIERS.has(specifier)) {
		if (localBarrelReach() === "unreachable") return null;
		return `imports from own-directory barrel '${specifier}' — import from the sibling submodule directly: ${originalLine.trim().slice(0, 120)}`;
	}
	if (ownPackageName !== null && specifier === ownPackageName) {
		return `imports from own package '${ownPackageName}' — use a deep submodule path instead: ${originalLine.trim().slice(0, 120)}`;
	}
	return null;
}

/**
 * Detect imports from the file's own package barrel.
 *
 * Two patterns flagged, both forming latent module-init-order hazards:
 *   1. Local barrel re-import — file at `<dir>/<x>.ts` imports from `./index`,
 *      `./`, etc. The barrel re-exports `<x>` itself, so loading order
 *      depends on file-resolution and breaks tree-shaking.
 *   2. Own-package re-import — file inside a published package whose
 *      package.json declares `"name": "foo"` imports from `"foo"`. Same
 *      bug class, surfaces as a cycle through the published entrypoint.
 *
 * Effect's `@effect/no-import-from-barrel-package` rule catches the second
 * shape; the first generalizes to any project structure.
 *
 * Skips: test files (and a bare `test.ts` / `spec.ts` with test-runner
 * evidence that the barrel does not reach), non-JS/TS files, the barrel file
 * itself (`<dir>/index.ts` legitimately re-exports its siblings), type-only
 * imports (erased at emit, no runtime edge), and a local `./index` that
 * exists on disk but never reaches the importer through edges inside its
 * directory subtree (an implementation module named `index.ts`, not a
 * barrel). A missing `index.*` keeps the finding: the barrel may simply be
 * unsaved.
 */
export function checkImportFromOwnBarrel(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Skip the barrel itself — index.ts is allowed to re-export from siblings.
	const base = basename(filePath, extname(filePath));
	if (base === "index") return [];

	// Strings get stripped to empty `""` for comment-filtering, so the line
	// presence/leading-keyword check runs on stripped lines while specifier
	// extraction reads from the original.
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const dir = dirname(filePath);
	const ownPackageName = nearestPackageName(dir);
	// Computed once per file, and only when a local barrel specifier shows up.
	let reach: BarrelReach | undefined;
	const localBarrelReach = (): BarrelReach => {
		reach ??= barrelReach(filePath);
		return reach;
	};
	// A bare `test.ts` beside `index.ts` is a test unless the barrel provably reaches it.
	if (isBareTestModule(base, content) && localBarrelReach() !== "reaches") return [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 5) break;
		const originalLine = originalLines[i] ?? "";
		// Confirm it's actually an `import ... from <spec>` or `export ... from <spec>`
		// shape, not e.g. `export function ...`. The original line carries the spec.
		const specifier = extractImportSpecifier(nonNull(strippedLines[i]), originalLine);
		if (specifier === null) continue;
		const text = matchBarrelSpecifier(specifier, originalLine, ownPackageName, localBarrelReach);
		if (text === null) continue;
		matches.push({ line: i + 1, text });
	}

	return matches;
}

/** Exported for tests so the package-name cache can be cleared between runs. */
export function _resetPackageNameCacheForTests(): void {
	_pkgNameCache.clear();
}
