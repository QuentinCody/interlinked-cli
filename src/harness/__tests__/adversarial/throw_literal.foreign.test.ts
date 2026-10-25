// Cross-repo falsification of the `throw_literal` pre_block check (2026-10-21,
// scratch/2026-10-21-cross-repo/falsify-result.json: 5 read, 5 confirmed
// false positives, 0 true positives). Each negative is the REAL snippet at
// the cited location in sindresorhus/ky @ 3541888 (trimmed, attributed).
//
// Blind spot closed: the broad `isTestFile` classifier exempts `/tests/`,
// `/__tests__/` and `/src/test/` but not a top-level `test/` directory of
// plain `*.ts` files (the ava convention; ky's whole suite). A non-Error
// throw there is the deliberate input of a "non-Error values pass through"
// test. The detector now also consults the shared `isTestSourcePath`
// classifier (the same route `floating_promises` takes), whose directory
// match is anchored `(?:^|\/)tests?\/`.
//
// The positives keep the class: product code still blocks, including the
// `as unknown as Error` cast (it silences the type checker, not the defect),
// and a product directory whose name merely ENDS in "test" is not a test dir.

import { describe, expect, it } from "vitest";
import { checkThrowLiteral } from "../../checks/agent-safety-advanced-style.js";

const KY_ROOT = "/tmp/ky-clone/ky";

// ky test/fetch.ts:578-588 (verbatim).
const KY_FETCH = [
	"test('a synchronously thrown non-Error value is propagated as-is', async t => {",
	"\tconst error = await t.throwsAsync<unknown>(ky(fixture, {",
	"\t\tretry: 0,",
	"\t\tfetch() {",
	"\t\t\t// eslint-disable-next-line @typescript-eslint/only-throw-error",
	"\t\t\tthrow 'sync boom';",
	"\t\t},",
	"\t}) as unknown as Promise<unknown>, {any: true});",
	"",
	"\tt.is(error, 'sync boom');",
	"});",
].join("\n");

// ky test/hooks.ts:1776-1781 (verbatim).
const KY_HOOKS_CAST = [
	"\t\tawait ky.get(server.url, {",
	"\t\t\thooks: {",
	"\t\t\t\tbeforeRetry: [",
	"\t\t\t\t\t() => {",
	"\t\t\t\t\t\tthrow 'oops' as unknown as Error;",
	"\t\t\t\t\t},",
	"\t\t\t\t],",
].join("\n");

// ky test/hooks.ts:2660-2664 (verbatim).
const KY_HOOKS_NETWORK = [
	"\t\tawait ky('https://example.com', {",
	"\t\t\tretry: 0,",
	"\t\t\tasync fetch() {",
	"\t\t\t\t// eslint-disable-next-line @typescript-eslint/only-throw-error",
	"\t\t\t\tthrow 'network down';",
	"\t\t\t},",
].join("\n");

// ky test/hooks.ts:7883-7886 (verbatim).
const KY_HOOKS_BEFORE_REQUEST = [
	"\t\t\t\tbeforeRequest: [() => {",
	"\t\t\t\t\t// eslint-disable-next-line @typescript-eslint/only-throw-error",
	"\t\t\t\t\tthrow 'thrown string';",
	"\t\t\t\t}],",
].join("\n");

// ky test/retry-decisions.ts:265-268 (verbatim).
const KY_RETRY = [
	"\t\tasync fetch() {",
	"\t\t\trequestCount++;",
	"\t\t\t// eslint-disable-next-line @typescript-eslint/only-throw-error",
	"\t\t\tthrow 'temporary failure';",
	"\t\t},",
].join("\n");

describe("throw_literal foreign — negative (must not fire)", () => {
	it("N1: ky test/fetch.ts:583 — a non-Error value thrown by a fake fetch (repo-relative path)", () => {
		expect(checkThrowLiteral(KY_FETCH, "test/fetch.ts")).toEqual([]);
	});

	it("N2: ky test/hooks.ts:1779 — a string thrown with an `as unknown as Error` cast (absolute path)", () => {
		expect(checkThrowLiteral(KY_HOOKS_CAST, `${KY_ROOT}/test/hooks.ts`)).toEqual([]);
	});

	it("N3: ky test/hooks.ts:2664 — a string thrown by an async fake fetch", () => {
		expect(checkThrowLiteral(KY_HOOKS_NETWORK, `${KY_ROOT}/test/hooks.ts`)).toEqual([]);
	});

	it("N4: ky test/hooks.ts:7885 — a string thrown by a beforeRequest hook", () => {
		expect(checkThrowLiteral(KY_HOOKS_BEFORE_REQUEST, "test/hooks.ts")).toEqual([]);
	});

	it("N5: ky test/retry-decisions.ts:268 — the NonError-wrapping input", () => {
		expect(checkThrowLiteral(KY_RETRY, `${KY_ROOT}/test/retry-decisions.ts`)).toEqual([]);
	});
});

describe("throw_literal foreign — positive (must fire)", () => {
	it("P1: the same throw in ky's product source still blocks", () => {
		expect(checkThrowLiteral(KY_RETRY, `${KY_ROOT}/source/core/Ky.ts`)).toHaveLength(1);
	});

	it("P2: an `as unknown as Error` cast in product code still blocks", () => {
		expect(checkThrowLiteral(KY_HOOKS_CAST, "source/utils/hooks.ts")).toHaveLength(1);
	});

	it("P3: a product directory whose name ends in `test` (`latest/`) is not a test directory", () => {
		expect(checkThrowLiteral("throw 'stale';", "src/latest/client.ts")).toHaveLength(1);
	});

	it("P4: a `testing/` helper directory is not a test directory", () => {
		expect(checkThrowLiteral("throw 404;", "src/testing/fake-server.ts")).toHaveLength(1);
	});
});
