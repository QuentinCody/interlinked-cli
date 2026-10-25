// ===========================================
// mocking_the_sut — mock calls that keep the REAL module
// ===========================================
// Sibling of taste-checks-test-assertions.ts (that file sits at the per-file
// line cap). Two shapes replace nothing, so the SUT still runs:
//   - vitest's `{ spy: true }` option (vitest >= 3): every export keeps its
//     body and is only wrapped in a spy;
//   - a factory that returns the actual module WHOLESALE:
//     `() => jest.requireActual("./foo")`, `async (importOriginal) =>
//     importOriginal()`, or `() => ({ __esModule: true, ...jest.requireActual
//     ("./foo") })` — the ts-jest / babel interop idiom that makes the
//     module's exports configurable so `jest.spyOn` can wrap one, or a test
//     that undoes a setup-file mock (2026-10-21 adversarial review, round 2).
// A factory that overrides any export is still a replacement and still fires.

import { nonNull } from "../lib/non-null.js";

/** The text after the path that `{ spy: true }` starts with. Anchored so a factory RETURNING `{ spy: true }` is still a replacement. */
const SPY_OPTION_AFTER_PATH = /^\s*,\s*\{\s*spy\s*:\s*true\b/;
const LOOKAHEAD_LINES = 6;

/** `, () =>` / `, async (importOriginal) =>` / `, orig =>` — the factory head; group 1 is the parameter name. */
const FACTORY_HEAD = /^\s*,\s*(?:async\s*)?(?:\(\s*(?:([A-Za-z_$][\w$]*)\s*(?::[^)]*)?)?\)|([A-Za-z_$][\w$]*))\s*=>\s*/;
const ACTUAL_REQUIRE = /(?:jest\s*\.\s*requireActual|vi\s*\.\s*importActual)\s*(?:<[^>]*>)?\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const ACTUAL = "@@ACTUAL@@";
const ACTUAL_EXPR = String.raw`(?:\(\s*)?(?:await\s+)?${ACTUAL}(?:\s*\))?`;
const ESMODULE = String.raw`__esModule\s*:\s*true\s*`;
/** After the head: the actual module itself, or an object spreading it with only `__esModule: true` beside it. Then the mock call closes. */
const WHOLESALE_BODY = new RegExp(
	String.raw`^(?:${ACTUAL_EXPR}|\(\s*\{\s*(?:${ESMODULE},\s*)?\.\.\.\s*${ACTUAL_EXPR}\s*(?:,\s*${ESMODULE})?,?\s*\}\s*\))\s*\)`,
);

/** Basename (no ext) of a SAME-DIRECTORY relative import, or "" when the path is
 *  `../`-prefixed or in a sub-directory — those are different modules even if the
 *  basename matches the SUT (basename-only matching false-flagged them, e.g.
 *  `../commands/foo.js` vs the SUT `./foo.ts`; fixed 2026-06-12). The caller
 *  guards `sut !== ""`, so a "" result never matches. */
export function sameDirSiblingBase(mockedPath: string): string {
	const rel = mockedPath.replace(/^\.\//, "");
	return rel.includes("/") ? "" : rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

/** Does `tail` (the text after the mocked path) pass the actual module through untouched? */
function returnsActualModule(tail: string, sut: string): boolean {
	const head = FACTORY_HEAD.exec(tail);
	if (!head) return false;
	let body = tail.slice(head[0].length).replace(ACTUAL_REQUIRE, (m, _q: string, path: string) =>
		sameDirSiblingBase(path) === sut ? ACTUAL : m,
	);
	const param = head[1] ?? head[2];
	if (param) body = body.replace(new RegExp(String.raw`\b${param.replace(/\$/g, "\\$")}\s*(?:<[^>]*>)?\s*\(\s*\)`, "g"), ACTUAL);
	return WHOLESALE_BODY.test(body);
}

/** Is the mock call whose path ends at `afterPath` on line `i` one that keeps the real module? */
export function keepsRealModule(sLines: string[], i: number, afterPath: number, sut: string): boolean {
	const tail = [nonNull(sLines[i]).slice(afterPath), ...sLines.slice(i + 1, i + 1 + LOOKAHEAD_LINES)].join("\n");
	return SPY_OPTION_AFTER_PATH.test(tail) || returnsActualModule(tail, sut);
}
