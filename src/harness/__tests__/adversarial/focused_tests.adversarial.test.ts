// Independent adversarial pass over `focused_tests` (pre_block), 2026-10-21.
// Probe: scratch/2026-10-21-adversarial/focused_tests.probe.mts.
//
// The bare forms (`fit`, `fdescribe`, `fcontext`, `ftest`) are Jasmine/Jest
// GLOBALS. Before this pass the detector fired on any `fit(` token, so an
// xterm `fitAddon.fit()`, a curve-fitting `fit(points)` imported from the
// module under test, and a statistical `ftest(a, b)` all BLOCKED the edit.

import { describe, expect, it } from "vitest";
import { checkFocusedTests } from "../../checks/focused-tests.js";

describe("focused_tests — negative (must not fire)", () => {
	it("N1: a member call `fitAddon.fit()` (xterm FitAddon idiom) is not the global", () => {
		const code = [
			'import { FitAddon } from "@xterm/addon-fit";',
			"const fitAddon = new FitAddon();",
			'it("fits the terminal", () => {',
			"  fitAddon.fit();",
			"  expect(term.cols).toBeGreaterThan(0);",
			"});",
		].join("\n");
		expect(checkFocusedTests(code, "src/terminal/__tests__/term.test.ts")).toEqual([]);
	});

	it("N2: an optional-chained member call `addon?.fit()`", () => {
		const code = 'it("fits", () => { addon?.fit(); expect(1).toBe(1); });';
		expect(checkFocusedTests(code, "src/term.test.ts")).toEqual([]);
	});

	it("N3: `fit` imported from a RELATIVE module is the system under test", () => {
		const code = [
			'import { fit } from "../curve-fit.js";',
			'it("fits a line", () => {',
			"  const line = fit([[0, 0], [1, 1]]);",
			"  expect(line.slope).toBe(1);",
			"});",
		].join("\n");
		expect(checkFocusedTests(code, "src/stats/regression.test.ts")).toEqual([]);
	});

	it("N4: a statistical `ftest(a, b)` imported from a sibling module", () => {
		const code = [
			'import { ftest } from "./f-test.js";',
			'it("rejects equal variances", () => {',
			"  expect(ftest(a, b).p).toBeLessThan(0.05);",
			"});",
		].join("\n");
		expect(checkFocusedTests(code, "src/stats/anova.test.ts")).toEqual([]);
	});

	it("N5: a `function fit()` declared in the test file and then called", () => {
		const code = [
			"function fit(box: Box, into: Box): Box { return box; }",
			'it("fits a box", () => { expect(fit(a, b)).toEqual(a); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/layout.test.ts")).toEqual([]);
	});

	it("N6: a `const fit = (...) => ...` helper bound in the test file", () => {
		const code = [
			"const fit = (w: number) => Math.min(w, 100);",
			'it("clamps", () => { expect(fit(200)).toBe(100); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/layout.test.ts")).toEqual([]);
	});

	it("N7: `fit` destructured from a local module namespace", () => {
		const code = [
			'import * as curve from "../curve.js";',
			"const { fit } = curve;",
			'it("fits", () => { expect(fit(xs)).toBeDefined(); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N8: a class method named `fit` (definition and `this.fit(` call)", () => {
		const code = [
			"class FakeLayout { fit(w: number) { return w; } run() { return this.fit(1); } }",
			'it("runs", () => { expect(new FakeLayout().run()).toBe(1); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/fake.test.ts")).toEqual([]);
	});

	it("N9: a multi-line import of `fit` from a relative module", () => {
		const code = [
			"import {",
			"  fit,",
			"  residuals,",
			'} from "../curve-fit.js";',
			'it("fits", () => { expect(fit(xs)).toBeDefined(); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/curve.test.ts")).toEqual([]);
	});

	// Round 2 (independent reviewer, same day): shapes the first pass did not try.
	// Probe: scratch/2026-10-21-adversarial/focused_tests.round2.probe.mts.

	it("N10: a TYPED const binding `const fit: Fitter = makeFitter();`", () => {
		const code = [
			"const fit: Fitter = makeFitter();",
			'it("fits", () => { expect(fit([1, 2])).toBeDefined(); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/stats/fitter.test.ts")).toEqual([]);
	});

	it("N11: a typed `let fit: Fn;` with no initializer, assigned in beforeEach", () => {
		const code = [
			"let fit: (xs: number[]) => Line;",
			"beforeEach(() => { fit = makeFitter(); });",
			'it("fits", () => { expect(fit([1, 2]).slope).toBe(1); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/stats/fitter.test.ts")).toEqual([]);
	});

	it("N12: an interface method SIGNATURE `fit(points: Point[]): Line;`", () => {
		const code = [
			"interface Fitter { fit(points: Point[]): Line; }",
			'it("uses a fake fitter", () => { expect(makeFake().run()).toBe(1); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N13: an `abstract fit(x: number): number;` member signature", () => {
		const code = ["abstract class Base { abstract fit(x: number): number; }", 'it("x", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N14: an arrow PARAMETER named `fit` called in its body", () => {
		const code = "const runAll = (fitters: Fitter[]) => fitters.map((fit) => fit(points));";
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N15: a typed function parameter `fit: (xs: number[]) => Line`", () => {
		const code = "function tryFit(fit: (xs: number[]) => Line, xs: number[]) { return fit(xs); }";
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N16: a destructured parameter `({ fit }: Deps)`", () => {
		const code = "function run({ fit }: Deps) { return fit(data); }";
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N17: a `for (const fit of fitters)` loop binding", () => {
		const code = 'it("runs each", () => { for (const fit of fitters) expect(fit(points)).toBeDefined(); });';
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N18: a generator declaration `function* fit(` then a plain call", () => {
		const code = [
			"function* fit(boxes: Box[]) { for (const b of boxes) yield b; }",
			'it("yields", () => { const gen = fit(bs); expect(gen.next().done).toBe(false); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/layout.test.ts")).toEqual([]);
	});

	// Round 3 (independent reviewer, resume pass): mocks named like a focus
	// global, initializers that only MENTION `window`, multi-line and array
	// patterns, default+named imports, prettier-wrapped definitions, and
	// forwarding wrappers. Probe: scratch/2026-10-21-adversarial/focused_tests.round3.probe.mts.

	it("N19: a `jest.fn()` mock named `fit` — calling the runner makes a new value", () => {
		const code = ["const fit = jest.fn(() => line);", 'it("calls", () => { fit(points); });'].join("\n");
		expect(checkFocusedTests(code, "src/stats/model.test.ts")).toEqual([]);
	});

	it("N20: a `jasmine.createSpy(\"fit\")` spy named `fit`", () => {
		const code = ['const fit = jasmine.createSpy("fit");', 'it("calls", () => { fit(points); });'].join("\n");
		expect(checkFocusedTests(code, "src/stats/model.spec.ts")).toEqual([]);
	});

	it("N21: a helper whose body only mentions `window`", () => {
		const code = [
			"const fit = (w: number) => Math.min(w, window.innerWidth);",
			'it("clamps", () => { expect(fit(99999)).toBe(window.innerWidth); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/layout.test.ts")).toEqual([]);
	});

	it("N22: an arrow parameter `fit` whose call mentions `window`", () => {
		const code = "const sizes = fitters.map((fit) => fit(window.innerWidth));";
		expect(checkFocusedTests(code, "src/layout.test.ts")).toEqual([]);
	});

	it("N23: a multi-line destructure from a dynamic import of the SUT", () => {
		const code = [
			"const {",
			"  fit,",
			"  residuals,",
			'} = await import("../curve-fit.js");',
			'it("fits", () => { expect(fit(xs)).toBeDefined(); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/curve.test.ts")).toEqual([]);
	});

	it("N24: an array-destructured binding `const [fit, refit] = makeFitters();`", () => {
		const code = ["const [fit, refit] = makeFitters();", 'it("fits", () => { expect(fit(xs)).toBeDefined(); });'].join(
			"\n",
		);
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N25: a default + named import `import fit, { residuals } from \"../curve-fit.js\"`", () => {
		const code = ['import fit, { residuals } from "../curve-fit.js";', 'it("fits", () => { expect(fit(xs)).toBeDefined(); });'].join(
			"\n",
		);
		expect(checkFocusedTests(code, "src/curve.test.ts")).toEqual([]);
	});

	it("N26: a prettier-wrapped method DEFINITION `fit(` whose `): Size {` is on a later line", () => {
		const code = [
			"class FakeFitAddon {",
			"  fit(",
			"    container: HTMLElement,",
			"    options: FitOptions,",
			"  ): Size {",
			"    return { cols: 80, rows: 24 };",
			"  }",
			"}",
		].join("\n");
		expect(checkFocusedTests(code, "src/fake-layout.test.ts")).toEqual([]);
	});

	it("N27: a prettier-wrapped interface SIGNATURE ending `): Line;`", () => {
		const code = ["interface Fitter {", "  fit(", "    points: Point[],", "  ): Line;", "}"].join("\n");
		expect(checkFocusedTests(code, "src/model.test.ts")).toEqual([]);
	});

	it("N28: a wrapper that DEFINES its own `.only` by forwarding to `describe.only`", () => {
		const code = [
			"export function describeWithDb(name: string, fn: () => void) { describe(name, () => { setupDb(); fn(); }); }",
			"describeWithDb.only = (name: string, fn: () => void) => describe.only(name, () => { setupDb(); fn(); });",
		].join("\n");
		expect(checkFocusedTests(code, "src/__tests__/helpers/describe-db.ts")).toEqual([]);
	});

	it("N29: an object member `only: (n, f) => it.only(n, f)` in a wrapper", () => {
		const code = "export const itWithDb = Object.assign(base, { only: (n: string, f: Fn) => it.only(n, wrap(f)) });";
		expect(checkFocusedTests(code, "src/__tests__/helpers/it-db.ts")).toEqual([]);
	});
});

describe("focused_tests — positive (must fire)", () => {
	it("P10: a prettier-wrapped focus CALL `fit(` with its title on the next line still fires", () => {
		const code = ["fit(", '  "a long description that prettier wrapped",', "  () => {", "    expect(1).toBe(1);", "  },", ");"].join(
			"\n",
		);
		expect(checkFocusedTests(code, "src/x.test.ts")).toEqual([{ line: 1, text: "fit(" }]);
	});

	it("P11: `const fit = (globalThis as any).fit;` is a re-export and still fires", () => {
		const code = ["const fit = (globalThis as any).fit;", 'fit("focused", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P12: a multi-line runner destructure `const {\\n fit,\\n} = require(\"jasmine\")` binds nothing", () => {
		const code = ["const {", "  fit,", '} = require("jasmine");', 'fit("focused", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toEqual([{ line: 4, text: 'fit("focused", () => {});' }]);
	});

	it("P13: a forwarding wrapper on one line does not silence a real `.only(` call on the next", () => {
		const code = [
			"describeWithDb.only = (name: string, fn: () => void) => describe.only(name, fn);",
			'describe.only("focused", () => {});',
		].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toEqual([{ line: 2, text: 'describe.only("focused", () => {});' }]);
	});

	it("P14: a rename `const { fit: fitLine } = curve` binds `fitLine`, so a bare `fit(` still fires", () => {
		const code = ["const {", "  fit: fitLine,", "} = curve;", 'fit("focused", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P1: a bare Jasmine `fit(` with no local binding still fires", () => {
		const code = 'fit("focused", () => { expect(1).toBe(1); });';
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P2: `fit` imported from a RUNNER module (@jest/globals) is still a focus marker", () => {
		const code = ['import { fit } from "@jest/globals";', 'fit("focused", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toEqual([
			{ line: 2, text: 'fit("focused", () => {});' },
		]);
	});

	it("P3: a binding that re-exposes a runner global (`const fit = globalThis.fit`) is no shadow", () => {
		const code = ["const fit = globalThis.fit;", 'fit("focused", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P4: `const { fit } = require(\"jasmine\")` is a runner binding, not a shadow", () => {
		const code = ['const { fit } = require("jasmine");', 'fit("focused", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P5: a local `fit` binding does not silence `it.only(` on another line", () => {
		const code = [
			'import { fit } from "../curve-fit.js";',
			'it.only("fits", () => { expect(fit(xs)).toBeDefined(); });',
		].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P6: `fdescribe(` with a function-expression body still fires", () => {
		const code = 'fdescribe("group", function () { it("x", () => {}); });';
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P7: a typed const named `fitted` does not bind `fit`; the bare focus call still fires", () => {
		const code = ["const fitted: Line = compute();", 'fit("focused", () => { expect(fitted).toBeDefined(); });'].join(
			"\n",
		);
		expect(checkFocusedTests(code, "src/x.test.ts")).toEqual([
			{ line: 2, text: 'fit("focused", () => { expect(fitted).toBeDefined(); });' },
		]);
	});

	it("P8: a comma-separated runner destructure `const { fit, fdescribe, ftest } = require(\"jasmine\")` binds nothing", () => {
		const code = ['const { fit, fdescribe, ftest } = require("jasmine");', 'fdescribe("g", () => {});'].join("\n");
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});

	it("P9: a focus call whose arrow has a typed parameter list `fit(\"x\", (done: Done) => {})` still fires", () => {
		const code = 'fit("x", (done: Done) => { done(); });';
		expect(checkFocusedTests(code, "src/x.test.ts")).toHaveLength(1);
	});
});
