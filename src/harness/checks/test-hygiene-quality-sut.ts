// Test-file hygiene checks — test-quality family (Batch 2), SUT-pairing cluster.
//
// Sections 5 ("missing SUT import") and 6 ("mocking the SUT self"), plus their
// shared 2026-07 exemption helpers, extracted from test-hygiene-quality.ts to
// keep that module under the per-file line cap. Both public checks and
// `hasAnyProjectSourceImport` are re-exported from test-hygiene-quality.ts
// (and the test-hygiene.ts barrel) so the check registry and every importer
// stay unchanged. Behavior is byte-identical to the pre-extraction inline
// definitions.

import { nonNull } from "../../lib/non-null.js";
import { MUTATION_DIRECTED_SUFFIX } from "./test-legitimacy.js";
import {
	getExtension,
	type InlineMatch,
	isStrictTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// ==========================================================================
// 5. Test file missing SUT import
// ==========================================================================
// `foo.test.ts` should import something resembling `./foo`. Without that, the test
// almost certainly isn't testing what its name claims. Conservative: only fires if NO
// relative import matches the SUT basename (type-only / namespace / re-export all count).
// The basename also drops the mutation-directed suffix chain, one grammar shared with
// MUTATION_DIRECTED_PATH: `foo.mutation-kill.test.ts` names SUT `foo`, and looking for the
// phantom `./foo.mutation-kill` false-fired on every such suite in the tree (followup #24).

/** Public API — flags test files that don't import their SUT. */
export function checkTestMissingSutImport(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return [];

	const norm = filePath.replace(/\\/g, "/");
	const fileName = norm.split("/").pop() || "";
	const stripped = fileName.replace(/\.(test|spec)\.(tsx?|jsx?|mjs|cjs)$/, "");
	const sutBase = stripped.replace(MUTATION_DIRECTED_SUFFIX, "");
	if (!sutBase || stripped === fileName || sutBase === "index") return [];
	if (norm.includes("__fixtures__/") || norm.includes("/__mocks__/")) return [];

	// Build a pattern that looks for the SUT in any relative import — quote
	// kind, optional ./ ../, optional path prefix, basename, optional .js.
	const escaped = sutBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const importPattern = new RegExp(
		`(?:from|require|import)\\s*\\(?\\s*["']\\.{1,2}\\/(?:[^"']*\\/)?${escaped}(?:\\.(?:js|ts|tsx|mjs|cjs))?["']`,
	);
	if (importPattern.test(content)) return [];
	if (hasAnyProjectSourceImport(content)) return [];
	// 2026-09 refinements — resolve the file's ACTUAL imports (name-lineage
	// siblings, dynamic import()), and recognise the two ways a test exercises
	// the product without importing a module at all (see exercisesRealSut).
	if (exercisesRealSut(content, sutBase)) return [];
	// 2026-07 refinements — subprocess-run SUTs, regression suites, multi-module
	// suites (helpers at file end, next to hasAnyProjectSourceImport).
	if (isExemptFromSutPairing(content, sutBase, escaped)) return [];

	return [
		{
			line: 1,
			text: `test file does not import its SUT (\`./${sutBase}\` not found, and the file imports no other project source). The test is not testing what its name claims.`,
		},
	];
}

// ==========================================================================
// 6. Mocking the SUT in its own test
// ==========================================================================
// `vi.mock("./foo")` / `jest.mock("./foo")` inside `foo.test.ts` where
// the relative path resolves to the SUT itself. Almost always means the
// agent silenced the actual code under test rather than fixing it.

const SUT_MOCK_RE = /\b(?:vi|jest)\s*\.\s*mock\s*\(\s*["']([^"']+)["']/g;

/** True when a vi.mock/jest.mock `target` resolves to the test's OWN sibling
 *  SUT — a SAME-DIRECTORY relative import whose basename matches `sutBase`. A
 *  `../`-prefixed or sub-directory specifier that merely shares the basename is
 *  a DIFFERENT module (e.g. `../commands/foo.js` vs the SUT `./foo.ts`) and must
 *  NOT be flagged — basename-only matching false-flagged those (fixed 2026-06-12). */
function mockTargetIsSut(target: string, sutBase: string): boolean {
	const rel = target.replace(/^\.\//, "");
	if (rel.includes("/")) return false; // not a same-directory sibling
	return rel.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, "") === sutBase;
}

/** Public API — flags mocks of the SUT inside its own test file. */
export function checkMockingTheSutSelf(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const norm = filePath.replace(/\\/g, "/");
	const fileName = norm.split("/").pop() || "";
	const sutBase = fileName.replace(/\.(test|spec)\.(tsx?|jsx?|mjs|cjs)$/, "");
	if (!sutBase || sutBase === fileName) return [];

	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 3;

	SUT_MOCK_RE.lastIndex = 0;
	let m: RegExpExecArray | null = SUT_MOCK_RE.exec(content);
	while (m !== null && matches.length < MAX_MATCHES) {
		const target = nonNull(m[1]);
		if (mockTargetIsSut(target, sutBase)) {
			const offset = m.index;
			const lineIdx = (content.slice(0, offset).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `test mocks the system under test (\`${target}\`). The test is no longer verifying its target — fix the SUT or test something else.`,
			});
		}
		m = SUT_MOCK_RE.exec(content);
	}
	return matches;
}

// Tier 2 helper for checkTestMissingSutImport.
//
// SCOPE: only PARENT-directory imports (`../...`) count as Tier 2
// evidence. The shape captured is the multi-SUT test grouping pattern
// (e.g. `__tests__/tdd-cycle.test.ts` imports `../behavioral-checks.js`
// to test a related-but-differently-named module). Same-directory imports
// (`./xxx`) are intentionally excluded: a `foo.test.ts` that imports
// `./bar.js` but not `./foo.js` is still the canonical "misnamed test"
// bug class the strict tier was built to catch.
export function hasAnyProjectSourceImport(content: string): boolean {
	const re = /(?:from|require)\s*\(?\s*["'](\.\.\/[^"']+)["']/g;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		const spec = nonNull(m[1]);
		const isTestImport = /\.(test|spec)\./.test(spec);
		const isMockImport = /(?:^|\/)__mocks__\//.test(spec);
		const isFixtureImport = /(?:^|\/)__fixtures__\//.test(spec);
		const isAssetImport =
			/\.(?:json|css|scss|less|html|svg|png|jpg|jpeg|gif|md)$/i.test(spec);
		if (!isTestImport && !isMockImport && !isFixtureImport && !isAssetImport) {
			return true;
		}
		m = re.exec(content);
	}
	return false;
}

// --- checkTestMissingSutImport FP refinements (2026-07, verify-noise run) ---
// Three shapes where the companion-module assumption breaks:
// (a) codemod / script tests exercise the SUT via SUBPROCESS
//     (`spawnSync("node", ["scripts/foo.mjs"])`) rather than import — the
//     companion path appearing in a string, in a file that spawns
//     subprocesses, is import-equivalent;
// (b) deliberately cross-cutting regression suites (cli-bugs.test.ts,
//     activity-workspace-regressions.test.ts) are NAMED for what they are —
//     a *bugs* / *regressions* basename has no companion module by design;
// (c) multi-module suites importing 3+ distinct CROSS-DIRECTORY (`../`)
//     project source modules are clearly testing SOMETHING real — the
//     misnamed-test bug class this check exists for imports zero or one.
//     Same-directory (`./`) siblings do NOT count toward this (see
//     countDistinctProjectImports): a foo.test.ts that imports `./bar`,
//     `./baz`, `./qux` but not `./foo` is still misnamed.

const REGRESSION_SUITE_NAME_RE = /(?:^|[-._])(?:regressions?|bugs?)(?:[-._]|$)/i;
const SUBPROCESS_CALL_RE =
	/\b(?:execSync|spawnSync|execFileSync|execFile|exec|spawn|fork)\s*\(/;
const SUBPROCESS_CALL_GLOBAL_RE =
	/\b(?:execSync|spawnSync|execFileSync|execFile|exec|spawn|fork)\s*\(/g;
const MIN_MULTI_MODULE_IMPORTS = 3;

/** True when the file spawns subprocesses AND names the companion module's
 *  file (`<sutBase>.<src ext>`) inside a string — running the SUT as a child
 *  process instead of importing it (the codemod-script test shape). */
function invokesSutAsSubprocess(content: string, escapedSutBase: string): boolean {
	if (!SUBPROCESS_CALL_RE.test(stripCommentsAndStrings(content))) return false;
	const pathInString = new RegExp(
		`["'\`][^"'\`]*\\b${escapedSutBase}\\.(?:m?[jt]sx?|cjs)\\b`,
	);
	return pathInString.test(content);
}

/** Count distinct CROSS-DIRECTORY (`../`) project-source relative imports
 *  (static, dynamic `import()`, or require) — test/mock/fixture/asset
 *  specifiers excluded. Same-directory (`./`) imports are deliberately NOT
 *  counted (mirrors hasAnyProjectSourceImport's `../`-only scope): a
 *  `foo.test.ts` importing 3 same-dir siblings but not `./foo` is still the
 *  misnamed-test shape this check exists to catch, so it must not clear the
 *  multi-module carve-out. */
function countDistinctProjectImports(content: string): number {
	const re = /(?:from|require|import)\s*\(?\s*["'](\.\.\/[^"']+)["']/g;
	const specs = new Set<string>();
	for (const m of content.matchAll(re)) {
		const spec = nonNull(m[1]);
		const isNonSourceImport =
			/\.(test|spec)\./.test(spec) ||
			/(?:^|\/)(?:__mocks__|__fixtures__)\//.test(spec) ||
			/\.(?:json|css|scss|less|html|svg|png|jpg|jpeg|gif|md)$/i.test(spec);
		if (!isNonSourceImport) specs.add(spec);
	}
	return specs.size;
}

// --- checkTestMissingSutImport SUT resolution (2026-09, adjudication run) ---
// A campaign run flagged 87 test files in this tree; adjudication found ZERO
// real orphans. Two FP classes, both from keying on the FILENAME STEM instead
// of on what the file actually imports and actually runs:
//
// (a) STEM-KEYED IMPORT MATCH. `taste-mutation-kill.test.ts` imports
//     `./taste.js`; `local-activity-large.test.ts` imports
//     `./local-activity.js`; `git-commands.test.ts` reaches `../git.js` only
//     through a DYNAMIC `await import(...)`, which the old `(?:from|require)`
//     scan never saw. The test names a BEHAVIOR or a SLICE of a module whose file
//     name differs from the test's own — so the SUT is imported, just under
//     another stem. Both directions of the name lineage count (`foo-bar` ⇄
//     `foo`), and lineage must break at a `-` / `.` / `_` boundary so
//     `foobar` never counts as `foo`.
// (b) BLACK-BOX PRODUCT DRIVING. An integration test that runs
//     `node dist/index.js` through execFileSync, or connects to the daemon's
//     `.sock`, legitimately imports no project module — the product IS the
//     subprocess. The same holds for artifact pins that read committed source
//     / config files off disk and assert on them.
//
// What still fires (deliberately, the canonical bug class): a `foo.test.ts`
// whose only project import is an UNRELATED same-directory sibling, and a
// test that imports nothing and runs nothing.

const NAME_BOUNDARY_RE = /[-._]/;
const RELATIVE_IMPORT_RE = /(?:from|require|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
// CONTENT reads only. `existsSync` / `statSync` are PROBES — they yield a
// boolean, never the artifact a pin asserts on, and `existsSync("package.json")`
// as an unrelated setup check was silencing genuine orphans (verifier, 2026-09-03).
const FS_READ_RE = /\b(?:readFileSync|readdirSync|globSync|readFile)\s*\(/;
const FS_READ_CALL_RE = /\b(?:readFileSync|readdirSync|globSync|readFile)\s*\(/g;
// A COMMITTED REPO ARTIFACT path: a product directory, either as its own
// `join(...)` segment or as the head of a path string. Deliberately NOT "any
// string ending in a known extension" — that matched `./fixtures/sample.json`
// and bare `package.json`, i.e. the most ordinary test-data load in the corpus,
// and silenced genuine orphans (verifier finding, 2026-09-03).
const REPO_PRODUCT_PATH_RE =
	/["'`](?:\.{0,2}\/)?(?:src|scripts|dist|docs|landing|protocol|skills|\.interlinked)(?:\/[^"'`]*)?["'`]|["'`][^"'`]*\b(?:package\.json|tsconfig[\w.-]*\.json|[\w.-]+\.conf\.json|biome\.jsonc?|knip\.json)["'`]/;
// Read arguments that name test DATA rather than a committed product artifact.
const TEST_DATA_PATH_RE = /fixture|__mocks__|snapshot|tmpdir|\btmp\b|\btemp\b|sample/i;
// Two spellings on purpose: `.test()` on a GLOBAL regex advances lastIndex and
// `matchAll` copies it, so a shared instance silently skips the first call.
const SOCKET_CALL_RE = /\b(?:createConnection|connect)\s*\(/;
const SOCKET_CALL_GLOBAL_RE = /\b(?:createConnection|connect)\s*\(/g;
const SOCKET_PATH_RE = /\.sock\b/;
// Deliberately narrow: the BUILT product's entry points (`dist/`, `bin/`,
// `node_modules/.bin/`) or the node binary itself. A test that shells out to
// some unrelated `scripts/*.mjs` is NOT driving its SUT and must still fire
// (pinned in test-hygiene-quality.test.ts).
// The second alternative catches the `join(root, "dist", "index.js")` form,
// where the directory is its own string segment; the third catches a package
// ENTRY POINT run from source (`spawnSync("npx", ["tsx", …, "index.ts"])`).
const PRODUCT_TARGET_STRING_RE =
	/["'`][^"'`]*(?:\bdist\/|\bbin\/|\bnode_modules\/)|["'`](?:dist|bin)["'`]|["'`][^"'`]*\bindex\.[mc]?[jt]s["'`]/;

/** True when `spec`'s basename shares a NAME LINEAGE with `sutBase` — equal,
 *  or one is a prefix of the other ending at a `-` / `.` / `_` boundary
 *  (`taste-mutation-kill` ⇄ `taste`). `foobar` vs `foo` is NOT lineage. */
function isNameLineage(sutBase: string, spec: string): boolean {
	const base = (spec.split("/").pop() ?? "").replace(/\.(m?[jt]sx?|cjs)$/, "");
	if (base === "" || sutBase === "") return false;
	if (base === sutBase) return true;
	const extendsAt = (long: string, short: string): boolean =>
		long.length > short.length &&
		long.startsWith(short) &&
		NAME_BOUNDARY_RE.test(long.charAt(short.length));
	return extendsAt(sutBase, base) || extendsAt(base, sutBase);
}

/** Every relative project-source specifier the file actually imports —
 *  static, dynamic `import()`, or require; test / mock / fixture / asset
 *  specifiers excluded (they are not a SUT). */
function collectProjectImports(content: string): string[] {
	const specs: string[] = [];
	for (const m of content.matchAll(RELATIVE_IMPORT_RE)) {
		const spec = nonNull(m[1]);
		const isNonSource =
			/\.(test|spec)\./.test(spec) ||
			/(?:^|\/)(?:__mocks__|__fixtures__)\//.test(spec) ||
			/\.(?:json|css|scss|less|html|svg|png|jpg|jpeg|gif|md)$/i.test(spec);
		if (!isNonSource) specs.push(spec);
	}
	return specs;
}

/** FP class (a): the SUT IS imported, under a stem the FILENAME does not
 *  repeat — a name-lineage module in any relative direction, reached by a
 *  static, dynamic (`import()`) or require specifier. An UNRELATED sibling
 *  still does not count: that is the misnamed-test shape the strict tier
 *  exists for, and the multi-module carve-out below keeps its own rules. */
function resolvesSutByImports(content: string, sutBase: string): boolean {
	return collectProjectImports(content).some((spec) => isNameLineage(sutBase, spec));
}

// --- Call-site binding (2026-09-03, verifier repair) ---
// Both black-box predicates below used to be a pair of INDEPENDENT booleans:
// "some spawn call exists anywhere" AND "some product-ish string exists
// anywhere". An orphan test running `execSync("echo hello")` next to an unused
// `const X = "some/random/index.js"` therefore cleared the check. The evidence
// must come from the SAME call: the product path has to be an ARGUMENT of the
// spawn/read, either literally or through a file-local const bound to one.

const CALL_ARG_SCAN_LIMIT = 2000;
const CONST_DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;

/** The argument text of the call whose opening paren sits at `open`, up to the
 *  matching close paren (bounded — a runaway paren yields the bounded slice). */
function sliceCallArguments(content: string, open: number): string {
	const end = Math.min(content.length, open + CALL_ARG_SCAN_LIMIT);
	let depth = 0;
	for (let i = open; i < end; i += 1) {
		const ch = content.charAt(i);
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) return content.slice(open + 1, i);
		}
	}
	return content.slice(open + 1, end);
}

/** Argument text of every call matching `callRe` (a GLOBAL regex ending at the
 *  callee's opening paren). */
function callArgumentRegions(content: string, callRe: RegExp): string[] {
	const regions: string[] = [];
	for (const m of content.matchAll(callRe)) {
		const open = m.index + m[0].length - 1;
		regions.push(sliceCallArguments(content, open));
	}
	return regions;
}

/** File-local const/let/var names whose initializer text satisfies `valueRe` —
 *  the one indirection a real black-box test uses (`const ENTRY = join(root,
 *  "dist", "index.js"); execFileSync(node, [ENTRY])`). */
function bindingsMatching(content: string, valueRe: RegExp): Set<string> {
	const names = new Set<string>();
	for (const m of content.matchAll(CONST_DECL_RE)) {
		if (valueRe.test(nonNull(m[2]))) names.add(nonNull(m[1]));
	}
	return names;
}

/** True when this call's ARGUMENTS carry the evidence — literally, or via a
 *  file-local binding that does. */
function argumentsCarry(region: string, valueRe: RegExp, bindings: Set<string>): boolean {
	if (valueRe.test(region)) return true;
	for (const name of bindings) {
		if (new RegExp(`\\b${name}\\b`).test(region)) return true;
	}
	return false;
}

/** FP class (b1): the test drives the BUILT product out of process — spawns a
 *  `dist/` / `bin/` / entry-point target, or opens the daemon's Unix socket.
 *  Such a test imports no module by design. The target must be an ARGUMENT of
 *  the spawn (or of the connect), not merely a string somewhere in the file. */
function drivesProductOutOfProcess(content: string): boolean {
	const code = stripCommentsAndStrings(content);
	if (SOCKET_CALL_RE.test(code)) {
		const sockBindings = bindingsMatching(content, SOCKET_PATH_RE);
		const opens = callArgumentRegions(content, SOCKET_CALL_GLOBAL_RE);
		if (opens.some((r) => argumentsCarry(r, SOCKET_PATH_RE, sockBindings))) return true;
	}
	if (!SUBPROCESS_CALL_RE.test(code)) return false;
	const bindings = bindingsMatching(content, PRODUCT_TARGET_STRING_RE);
	return callArgumentRegions(content, SUBPROCESS_CALL_GLOBAL_RE).some((r) =>
		argumentsCarry(r, PRODUCT_TARGET_STRING_RE, bindings),
	);
}

/** FP class (b2): the test is a FIXTURE / CONFIG PIN — it reads a committed
 *  PRODUCT artifact off disk (source, generated output, a repo config under a
 *  product directory) and asserts on it. The artifact is the SUT; there is no
 *  module to import. The path must be an ARGUMENT of the read, and a read of
 *  ordinary test DATA (`./fixtures/sample.json`, a tmpdir, a snapshot) is not
 *  an artifact pin — that pattern is ubiquitous in orphan tests too. */
function pinsOnDiskArtifact(content: string): boolean {
	if (!FS_READ_RE.test(stripCommentsAndStrings(content))) return false;
	const bindings = bindingsMatching(content, REPO_PRODUCT_PATH_RE);
	return callArgumentRegions(content, FS_READ_CALL_RE).some(
		(region) =>
			!TEST_DATA_PATH_RE.test(region) &&
			argumentsCarry(region, REPO_PRODUCT_PATH_RE, bindings),
	);
}

/** The 2026-09 SUT-resolution bundle — see the block comment above. */
function exercisesRealSut(content: string, sutBase: string): boolean {
	if (resolvesSutByImports(content, sutBase)) return true;
	if (drivesProductOutOfProcess(content)) return true;
	return pinsOnDiskArtifact(content);
}

/** Bundle of the 2026-07 exemptions — see the block comment above. */
function isExemptFromSutPairing(content: string, sutBase: string, escaped: string): boolean {
	if (REGRESSION_SUITE_NAME_RE.test(sutBase)) return true;
	if (invokesSutAsSubprocess(content, escaped)) return true;
	return countDistinctProjectImports(content) >= MIN_MULTI_MODULE_IMPORTS;
}
