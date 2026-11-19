// Import policy checks — module-graph hygiene.
// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.3).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { checkMatchLimit, isForegroundCheckScan } from "./check-scan-policy.js";
import { checkRoot, reportNotMeasured } from "./check-root.js";
import { inspectOwnBarrelReach, ownBarrelConsumerImports, type BarrelReach } from "./imports-barrel-reach.js";
import { getProjectCheckEvidence } from "./project-check-evidence.js";
import { proposedFileContent, proposedFileExists } from "./proposed-files.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
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

function unavailable(file: string, reason: string): void {
	getProjectCheckEvidence()?.reportUnavailable("import_from_own_barrel", file, reason);
	reportNotMeasured("import_from_own_barrel", `${file}: ${reason}`);
}

/** Resolve the `name` field of the nearest package.json walking up from `startDir`. */
function nearestPackageName(startDir: string): string | null {
	let dir = resolve(startDir);
	const limit = isForegroundCheckScan() ? Number.POSITIVE_INFINITY : 6;
	for (let i = 0; i < limit; i++) {
		const pkgPath = join(dir, "package.json");
		if (proposedFileExists(pkgPath) ?? existsSync(pkgPath)) {
			try {
				const pkg: unknown = JSON.parse(proposedFileContent(pkgPath) ?? readFileSync(pkgPath, "utf-8"));
				const name = isJsonObject(pkg) && typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : null;
				return name;
			} catch (error) {
				unavailable(pkgPath, `Package identity could not be read (${error instanceof Error ? error.message : String(error)})`);
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	unavailable(startDir, "Runtime package identity lookup exhausted its six-ancestor budget");
	return null;
}

/** Build the finding text for one specifier, or `null` if it isn't a barrel/own-package import. */
function matchBarrelSpecifier(
	specifier: string,
	originalLine: string,
	ownPackageName: () => string | null,
	localBarrelReach: (specifier: string) => BarrelReach,
): string | null {
	if (BARREL_LOCAL_SPECIFIERS.has(specifier)) {
		if (localBarrelReach(specifier).state !== "reaches") return null;
		return `imports from own-directory barrel '${specifier}' — import from the sibling submodule directly: ${originalLine.trim().slice(0, 120)}`;
	}
	if (specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("node:")) return null;
	const name = ownPackageName();
	if (name !== null && specifier === name) {
		return `imports from own package '${name}' — use a deep submodule path instead: ${originalLine.trim().slice(0, 120)}`;
	}
	return null;
}

/**
 * Detect imports from the file's own package barrel.
 *
 * Local value-form imports need an actual resolved return-edge witness inside
 * the sibling index's directory subtree. Missing or unsupported graph inputs
 * are unavailable evidence. An exact own-package import is separate syntactic
 * policy advice. Neither observation establishes a runtime failure by itself.
 */
export function checkImportFromOwnBarrel(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Skip the barrel itself — index.ts is allowed to re-export from siblings.
	const base = basename(filePath, extname(filePath));
	if (base === "index") return [];

	const matches: InlineMatch[] = [];
	const absolute = resolve(getProjectCheckEvidence()?.root ?? checkRoot(), filePath);
	const parsed = ownBarrelConsumerImports(content, absolute);
	for (const reason of parsed.gaps) unavailable(absolute, reason);
	const dir = dirname(absolute);
	let packageName: string | null | undefined;
	const ownPackageName = (): string | null => {
		if (packageName === undefined) packageName = nearestPackageName(dir);
		return packageName;
	};
	// Computed once per file, and only when a local barrel specifier shows up.
	const reaches = new Map<string, BarrelReach>();
	const localBarrelReach = (specifier: string): BarrelReach => {
		let reach = reaches.get(specifier);
		if (!reach) {
			reach = inspectOwnBarrelReach(absolute, specifier);
			reaches.set(specifier, reach);
			for (const gap of reach.gaps) unavailable(gap.file, gap.reason);
		}
		return reach;
	};
	// A bare `test.ts` beside `index.ts` is a test unless the barrel provably reaches it.
	if (isBareTestModule(base, content) && !parsed.imports.some(item => BARREL_LOCAL_SPECIFIERS.has(item.specifier) && localBarrelReach(item.specifier).state === "reaches")) return [];

	for (const item of parsed.imports) {
		if (matches.length >= checkMatchLimit(5)) break;
		const text = matchBarrelSpecifier(item.specifier, item.source, ownPackageName, localBarrelReach);
		if (text === null) continue;
		matches.push({ line: item.line, text });
	}

	return matches;
}

/** Compatibility export. Package identity is read once per detector invocation. */
export function _resetPackageNameCacheForTests(): void {
	// No cross-invocation package-name state remains.
}
