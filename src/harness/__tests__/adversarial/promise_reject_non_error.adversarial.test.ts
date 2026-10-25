// Independent adversarial review of the `promise_reject_non_error` pre_block
// check (2026-10-21). Every negative here was a probed false positive before
// the detector was refined: `scratch/2026-10-21-adversarial/promise_reject_non_error.probe.mts`.
// A pre_block check blocks an agent's edit, so each of these is a legitimate
// edit the gate used to refuse.

import { describe, expect, it } from "vitest";
import { checkPromiseRejectNonError } from "../../checks/agent-safety-advanced-style.js";

describe("promise_reject_non_error — negative (must not fire)", () => {
	it("N1: a lint / fix message that mentions the pattern inside a string literal", () => {
		const code =
			"export const MESSAGE = 'Reject with an Error: write Promise.reject(new Error(m)), not Promise.reject(\"m\").';\n";
		expect(checkPromiseRejectNonError(code, "src/rules/no-bad-reject.ts")).toEqual([]);
	});

	it("N2: a docs code sample carried as data in a template literal", () => {
		const code = 'export const BAD_EXAMPLE = `\n  return Promise.reject("boom");\n`;\n';
		expect(checkPromiseRejectNonError(code, "src/docs/examples.ts")).toEqual([]);
	});

	it("N3: prose in a tagged template (md / sql / gql) that names the pattern", () => {
		const code = "const doc = md`\nNever write Promise.reject('oops').\n`;\n";
		expect(checkPromiseRejectNonError(code, "src/lib/md.ts")).toEqual([]);
	});

	it("N4: a string mention on the same line as a real Error rejection", () => {
		const code = "log('do not Promise.reject(\"x\")'); return Promise.reject(new Error(why));\n";
		expect(checkPromiseRejectNonError(code, "src/lib/v.ts")).toEqual([]);
	});

	it("N5: a vendored / patched third-party file (upstream code is data, not authored)", () => {
		const code = 'module.exports.fail = function () { return Promise.reject("legacy"); };\n';
		expect(checkPromiseRejectNonError(code, "src/vendor/legacy-sdk.js")).toEqual([]);
	});

	it("N6: a jest manual mock under __mocks__ (test support, non-test filename)", () => {
		const code = 'export const connect = () => Promise.reject("ECONNREFUSED");\n';
		expect(checkPromiseRejectNonError(code, "src/__mocks__/net.ts")).toEqual([]);
	});

	it("N7: a `.reject` method on an identifier that merely ends in `Promise`", () => {
		// `cancelPromise` is a Deferred / custom object; its `.reject(reason)` is
		// outside the `Promise.reject` contract, exactly like the executor-bound
		// `reject(...)` the detector already declines to guess about.
		const code = "const cancelPromise = createDeferred<void>();\ncancelPromise.reject(\"cancelled\");\n";
		expect(checkPromiseRejectNonError(code, "src/lib/deferred.ts")).toEqual([]);
	});

	it("N8: a plain object whose `reject` takes a string reason", () => {
		const code = 'const FakePromise = { reject: (why: string) => why };\nFakePromise.reject("x");\n';
		expect(checkPromiseRejectNonError(code, "src/lib/shim.ts")).toEqual([]);
	});

	it("N9: JSX prose in a docs component that names the pattern", () => {
		const code = 'export const Guide = () => (\n  <p>\n    Never call Promise.reject("oops") in a handler.\n  </p>\n);\n';
		expect(checkPromiseRejectNonError(code, "src/docs/RejectGuide.tsx")).toEqual([]);
	});

	it("N10: inline JSX <code> text in a .jsx file", () => {
		const code = "export function Tip() { return <code>Promise.reject('x')</code>; }\n";
		expect(checkPromiseRejectNonError(code, "src/docs/Tip.jsx")).toEqual([]);
	});
});

describe("promise_reject_non_error — positive (must fire)", () => {
	it("P1: a real literal rejection still fires after the string-aware scan", () => {
		expect(checkPromiseRejectNonError('return Promise.reject("oh no");\n', "src/lib/tp.ts")).toHaveLength(1);
	});

	it("P2: a string mention and a real literal rejection on one line fires once", () => {
		const code = "log('Promise.reject(1)'); return Promise.reject(2);\n";
		expect(checkPromiseRejectNonError(code, "src/lib/tp2.ts")).toHaveLength(1);
	});

	it("P3: a template-literal rejection fires (the backtick delimiter survives blanking)", () => {
		expect(checkPromiseRejectNonError("return Promise.reject(`${why}`);\n", "src/lib/tp3.ts")).toHaveLength(
			1,
		);
	});

	it("P5: a real rejection inside a JSX expression container still fires", () => {
		const code = 'export const B = () => <button onClick={() => Promise.reject("nope")}>Go</button>;\n';
		expect(checkPromiseRejectNonError(code, "src/ui/B.tsx")).toHaveLength(1);
	});

	it("P4: the real global reached through a member chain still fires", () => {
		expect(checkPromiseRejectNonError('globalThis.Promise.reject("x");\n', "src/lib/tp4.ts")).toHaveLength(
			1,
		);
	});
});
