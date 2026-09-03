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

/** Bundle of the 2026-07 exemptions — see the block comment above. */
function isExemptFromSutPairing(content: string, sutBase: string, escaped: string): boolean {
	if (REGRESSION_SUITE_NAME_RE.test(sutBase)) return true;
	if (invokesSutAsSubprocess(content, escaped)) return true;
	return countDistinctProjectImports(content) >= MIN_MULTI_MODULE_IMPORTS;
}
