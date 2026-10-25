// Independent adversarial review of the `empty_catch` pre_block check
// (2026-10-21). Every negative here was a probed false positive before the
// detector was refined: `scratch/2026-10-21-adversarial/empty_catch.probe.mts`.
// A pre_block check blocks an agent's edit, so each of these is a legitimate
// edit the gate used to refuse.

import { describe, expect, it } from "vitest";
import { stripRegexLiterals } from "../../strip-helpers.js";
import { checkEmptyCatch } from "../../taste-checks-checks-2.js";

describe("empty_catch — negative (must not fire)", () => {
	it("N1: a promise handler `.catch(function () {})` is not a catch clause (tsc ES5 spelling of `.catch(() => {})`)", () => {
		expect(checkEmptyCatch("void save().catch(function () {});\n", "src/x.ts")).toEqual([]);
	});

	it("N2: an optional-chained promise handler `p?.catch(function onError() {})`", () => {
		expect(checkEmptyCatch("p?.catch(function onError() {});\n", "src/x.ts")).toEqual([]);
	});

	it("N3: an ES5 promise chain in a .js file `.then(render).catch(function(){})`", () => {
		expect(
			checkEmptyCatch("fetchThing().then(render).catch(function(){});\n", "src/legacy.js"),
		).toEqual([]);
	});

	it("N4: an identifier that merely ends in `catch` with an empty body", () => {
		expect(checkEmptyCatch("function safecatch(e: unknown) {}\n", "src/x.ts")).toEqual([]);
	});

	it("N5: a regex literal as an arrow body `(l) => /catch {}/.test(l)` is blanked, not scanned", () => {
		const code = "const isEmpty = (l: string) => /catch {}/.test(l);\n";
		expect(stripRegexLiterals(code)).toBe("const isEmpty = (l: string) =>           .test(l);\n");
		expect(checkEmptyCatch(code, "src/x.ts")).toEqual([]);
	});

	it("N6: the arrow-form promise handler `.catch(() => {})` stays quiet (consistency control)", () => {
		expect(checkEmptyCatch("void save().catch(() => {});\n", "src/x.ts")).toEqual([]);
	});

	it("N7: a thenable test double's class method `catch() {}` (empty parens are a syntax error for a clause)", () => {
		const code =
			"export class FakeThenable {\n\tthen(res: (v: number) => void) {\n\t\tres(1);\n\t}\n\tcatch() {}\n\tfinally() {}\n}\n";
		expect(checkEmptyCatch(code, "src/testing/fake-promise.ts")).toEqual([]);
	});

	it("N8: an object-literal PromiseLike stub method `catch() {},`", () => {
		const code = "const stub = {\n\tthen() {\n\t\treturn stub;\n\t},\n\tcatch() {},\n};\n";
		expect(checkEmptyCatch(code, "src/testing/stubs.ts")).toEqual([]);
	});

	it("N9: JSX prose `<code>catch (e) {}</code>` in a docs component", () => {
		const code = "export function Lint() {\n\treturn <p>Never leave <code>catch (e) {}</code> empty.</p>;\n}\n";
		expect(checkEmptyCatch(code, "src/docs/Lint.tsx")).toEqual([]);
	});

	it("N10: a one-parameter class method `catch(onRejected) {}` — it follows no try block", () => {
		expect(checkEmptyCatch("class P {\n\tcatch(onRejected) {}\n}\n", "src/testing/fake-promise.ts")).toEqual([]);
	});

	it("N11: a typed `catch(fn: unknown) {}` method right after a `then() {...}` method body", () => {
		const code = "class T {\n\tthen(r: (v: number) => void) {\n\t\tr(1);\n\t}\n\tcatch(fn: unknown) {}\n}\n";
		expect(checkEmptyCatch(code, "src/testing/thenable.ts")).toEqual([]);
	});

	it("N12: DSL methods named `try() {}` and `catch(e) {}` — the block before catch is a method body, not a try block", () => {
		expect(checkEmptyCatch("class Dsl {\n\ttry() {}\n\tcatch(e) {}\n}\n", "src/testing/dsl.ts")).toEqual([]);
	});
});

describe("empty_catch — positive (must fire)", () => {
	it("P1: a real empty try/catch clause still fires on the catch line", () => {
		expect(checkEmptyCatch("try {\n\ta();\n} catch (e) {}\n", "src/x.ts")).toHaveLength(1);
	});

	it("P2: an Allman-style empty catch clause still fires", () => {
		expect(checkEmptyCatch("try\n{\n\ta();\n}\ncatch (e)\n{\n}\n", "src/x.ts")).toHaveLength(1);
	});

	it("P3: a binding-less `catch {}` still fires", () => {
		expect(checkEmptyCatch("try { a(); } catch {}\n", "src/x.ts")).toHaveLength(1);
	});

	it("P4: `a > /re/` is still a regex, never a division (stripper refinement does not over-reach)", () => {
		expect(stripRegexLiterals("const r = a / b;")).toBe("const r = a / b;");
		expect(stripRegexLiterals("const r = n > /2/.test(s);")).toBe("const r = n >    .test(s);");
	});

	it("P5: an empty inner clause of a nested try still fires on its own line", () => {
		const code = "try {\n\ttry { a(); } catch {}\n} catch (e) {\n\tlog(e);\n}\n";
		expect(checkEmptyCatch(code, "src/x.ts")).toEqual([{ line: 2, text: "try { a(); } catch {}" }]);
	});

	it("P6: a comment between the try block and `catch` does not hide the clause", () => {
		expect(checkEmptyCatch("try {\n\ta();\n} /* swallow */ catch (e) {}\n", "src/x.ts")).toHaveLength(1);
	});

	it("P7: a destructured binding `catch ({ message }) {}` still fires", () => {
		expect(checkEmptyCatch("try {\n\ta();\n} catch ({ message }) {}\n", "src/x.ts")).toHaveLength(1);
	});
});
