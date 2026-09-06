// Writes `protocol/shadow-v1/contract-digest.json` — the vendoring pin the
// `interlinked-cloud` repo re-reads whenever it re-vendors the shadow contract.
//   npx tsx scripts/gen-shadow-contract-digest.mts            # regenerate
//   npx tsx scripts/gen-shadow-contract-digest.mts --check    # CI: fail if stale
//
// It mirrors `protocol/mutation-v3/contract-digest.json` EXACTLY, algorithm and
// field names included, so one reader understands both protocols:
//
//   sha256 over `label\0sha256(content)\n` lines in sorted label order.
//   Contract files are labeled relative to `protocol/shadow-v1` (except the
//   digest file itself); normative sources are labeled by their repo-relative
//   paths.
//
// WHAT IS NORMATIVE. Two sets, both DERIVED from the tree, never hand-listed:
//
//   1. Every non-test `.ts` file of the public protocol package
//      `src/harness/shadow/protocol` — the declarations, the parsers, the
//      registry, the byte grammars and the comparison logic.
//   2. Every file OUTSIDE that package reachable from those modules through
//      transitive relative imports. Today that is exactly
//      `src/harness/mutation/protocol-v3/canonical.ts`, which decides the BYTES
//      every shadow hash is computed over — a pin that omitted it would let the
//      canonicalizer change while the shadow digest stayed valid.
//
// Both lists are read from the filesystem, so a module added to the package, or
// a NEW cross-package import added to any of them, changes the digest the moment
// it lands. The broker-internal half moved to `interlinked-cloud` on 2026-09-04
// and is deliberately outside this pin.
//
// DISCOVERY IS FAIL-CLOSED. Imports are read from the TypeScript AST, not with
// a regex, and anything the generator cannot follow STOPS the run instead of
// being skipped: an unresolvable relative specifier, and a dynamic `import()`
// whose argument is computed. A dependency that discovery misses is a
// dependency the digest does not pin, which is the one failure this file
// cannot be allowed to have — it would report a fresh pin over a tree it had
// only partly read. Labels are normalized to POSIX separators so the digest
// does not depend on which platform generated it.
//
// Run it after ANY intentional change to the package or to
// `protocol/shadow-v1/`; the cloud repo must then re-vendor the new digest.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dirname, "..");
const CONTRACT_DIR = join(REPO_ROOT, "protocol/shadow-v1");
const PACKAGE_DIR = join(REPO_ROOT, "src/harness/shadow/protocol");
const DIGEST_FILE = "contract-digest.json";

const ALGORITHM =
	"sha256 over `label\\0sha256(content)\\n` lines in sorted label order: contract files are labeled relative to protocol/shadow-v1 (except this file); normative_sources are labeled by their listed repo-relative paths; every label uses POSIX separators";

/** Every label in the record uses POSIX separators, whatever the host is.
 *  `path.relative` returns `\`-separated labels on Windows, and a digest whose
 *  labels depend on the machine that generated it pins nothing across the two
 *  repositories. */
export function toPosixLabel(value: string): string {
	return value.split(sep).join("/");
}

interface Labeled {
	readonly label: string;
	readonly full: string;
}

export interface DigestRecord {
	readonly algorithm: string;
	readonly normative_sources: readonly string[];
	readonly files: number;
	readonly digest: string;
}

/** Every file under the contract directory except the digest itself — the
 *  digest cannot hash the file it is written into. */
function contractFiles(dir: string, into: Labeled[]): void {
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			contractFiles(full, into);
			continue;
		}
		const label = toPosixLabel(relative(CONTRACT_DIR, full));
		if (label !== DIGEST_FILE) into.push({ label, full });
	}
}

/** The package's own modules: every `.ts` file that is not a test. Directories
 *  are walked, so a future subdirectory is covered without an edit here. */
function packageModules(dir: string, into: string[]): void {
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			packageModules(full, into);
			continue;
		}
		if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
		into.push(full);
	}
}

/** The module specifier this node imports from, or null when it is not an
 *  import at all. Covers every ESM form the package can use: `import`,
 *  `import type`, a side-effect `import "…"`, `export … from`,
 *  `export * from`, `import x = require("…")`, and a dynamic `import("…")`.
 *
 *  A dynamic import whose argument is COMPUTED throws rather than being
 *  skipped: a specifier the generator cannot read is a dependency it cannot
 *  pin, and a pin with an unknown hole in it is worse than no pin. */
function moduleSpecifierOf(node: ts.Node): string | null {
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
		const specifier = node.moduleSpecifier;
		if (specifier === undefined) return null; // `export { x }` — no module
		if (!ts.isStringLiteral(specifier)) throw new Error(`non-literal module specifier: ${specifier.getText()}`);
		return specifier.text;
	}
	if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
		const reference = node.moduleReference.expression;
		if (!ts.isStringLiteralLike(reference)) throw new Error(`non-literal require(): ${reference.getText()}`);
		return reference.text;
	}
	if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
	const argument = node.arguments[0];
	if (argument === undefined || !ts.isStringLiteralLike(argument)) {
		throw new Error(`dynamic import() with a non-literal specifier cannot be pinned: ${node.getText()}`);
	}
	return argument.text;
}

/**
 * Every RELATIVE module specifier the file imports, read from the TypeScript
 * AST rather than matched with a regex. The regex this replaced recognized
 * only double-quoted `from "…"` / `import "…"`, so a single-quoted import, an
 * `import()` call, or an `import … = require(…)` was silently invisible — and
 * an invisible dependency is one the contract digest does not pin.
 *
 * Only relative specifiers matter: a bare specifier is an npm package pinned
 * by the lockfile, and `node:` builtins are the runtime's.
 */
export function relativeSpecifiersOf(fileName: string, source: string): string[] {
	const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const out: string[] = [];
	const visit = (node: ts.Node): void => {
		const specifier = moduleSpecifierOf(node);
		if (specifier !== null && specifier.startsWith(".")) out.push(specifier);
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(parsed, visit);
	return out;
}

/** Map an ESM specifier onto the TypeScript file it is compiled from. The
 *  package writes `.js` relative imports, so `./x.js` resolves to `./x.ts`.
 *
 *  FAILS the run when nothing resolves. The previous version returned null and
 *  the caller skipped it, so a typo'd or moved relative import quietly dropped
 *  a normative source out of the pin — the digest stayed "valid" while
 *  describing less of the tree than it claimed. */
export function resolveImportTarget(fromFile: string, specifier: string): string {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, join(base, "index.ts")];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	throw new Error(
		`unresolved relative import "${specifier}" in ${toPosixLabel(relative(REPO_ROOT, fromFile))} — ` +
			"a dependency the generator cannot resolve is a dependency the contract digest cannot pin",
	);
}

function insidePackage(full: string): boolean {
	return full.startsWith(`${PACKAGE_DIR}${sep}`);
}

/** Breadth of the import graph reachable from `seeds`, keeping only the files
 *  that lie OUTSIDE the package. Iterative, so a chain of external modules is
 *  followed to its end rather than stopping at the first hop. */
function externalDependencies(seeds: readonly string[]): string[] {
	const seen = new Set<string>(seeds);
	const external = new Set<string>();
	const queue = [...seeds];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined) break;
		for (const specifier of relativeSpecifiersOf(file, readFileSync(file, "utf8"))) {
			const target = resolveImportTarget(file, specifier);
			if (seen.has(target)) continue;
			seen.add(target);
			if (!insidePackage(target)) external.add(target);
			queue.push(target);
		}
	}
	return [...external];
}

function digestOf(labeled: readonly Labeled[]): string {
	const hash = createHash("sha256");
	for (const { label, full } of [...labeled].sort((a, b) => (a.label < b.label ? -1 : 1))) {
		const contentHash = createHash("sha256").update(readFileSync(full)).digest("hex");
		hash.update(`${label}\0${contentHash}\n`, "utf8");
	}
	return hash.digest("hex");
}

/** The whole computation, exported so the CLI freshness test recomputes exactly
 *  what this script writes rather than a second copy of the rules. */
export function buildShadowContractDigest(): DigestRecord {
	const modules: string[] = [];
	packageModules(PACKAGE_DIR, modules);
	const sources = [...modules, ...externalDependencies(modules)]
		.map((full) => toPosixLabel(relative(REPO_ROOT, full)))
		.sort();
	const labeled: Labeled[] = sources.map((source) => ({ label: source, full: join(REPO_ROOT, source) }));
	contractFiles(CONTRACT_DIR, labeled);
	return { algorithm: ALGORITHM, normative_sources: sources, files: labeled.length, digest: digestOf(labeled) };
}

export function serializeShadowContractDigest(record: DigestRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

export const SHADOW_DIGEST_PATH = join(CONTRACT_DIR, DIGEST_FILE);

function check(expected: string): void {
	const committed = existsSync(SHADOW_DIGEST_PATH) ? readFileSync(SHADOW_DIGEST_PATH, "utf8") : "";
	if (committed === expected) {
		process.stdout.write(`${DIGEST_FILE} is fresh\n`);
		return;
	}
	process.stderr.write(
		`${DIGEST_FILE} is STALE — the shadow contract changed without regenerating the pin.\n` +
			"Run: npx tsx scripts/gen-shadow-contract-digest.mts, then re-vendor and re-pin in interlinked-cloud.\n",
	);
	process.exitCode = 1;
}

function main(): void {
	const record = buildShadowContractDigest();
	const serialized = serializeShadowContractDigest(record);
	if (process.argv.includes("--check")) {
		check(serialized);
		return;
	}
	mkdirSync(CONTRACT_DIR, { recursive: true });
	writeFileSync(SHADOW_DIGEST_PATH, serialized);
	process.stdout.write(
		`wrote ${DIGEST_FILE}: ${record.files} files, ${record.normative_sources.length} normative sources, digest ${record.digest}\n`,
	);
}

// Run only when invoked as the CLI entry point. The freshness test imports
// `buildShadowContractDigest` from this module, and an import must never write
// the pin it is checking.
const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) main();
