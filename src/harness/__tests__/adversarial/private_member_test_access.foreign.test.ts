// Cross-repo falsification of the `private_member_test_access` pre_warn check
// (2026-10-21, scratch/2026-10-21-cross-repo/falsify-result.json). Every
// negative case is REAL test code from a foreign repository (zustand, zod)
// that the detector flagged before the refinement in
// taste-checks-test-assertions.ts; the positives pin the bug class so the
// fix cannot be a blanket exemption of `as any` or of dunders.

import { describe, expect, it } from "vitest";
import { checkPrivateMemberTestAccess } from "../../taste-checks-test-assertions.js";

const ZUSTAND = "/clones/zustand/tests/devtools.test.tsx";
const ZOD_DETACHED = "/clones/zod/packages/zod/src/v4/classic/tests/detached-methods.test.ts";
const ZOD_ERROR_UTILS = "/clones/zod/packages/zod/src/v4/classic/tests/error-utils.test.ts";
const ZOD_ERROR = "/clones/zod/packages/zod/src/v4/classic/tests/error.test.ts";
const TEST = "/repo/src/widget.test.ts";

describe("private_member_test_access — negative (must not fire)", () => {
	it("N1: zustand tests/devtools.test.tsx:120 — dunder-named browser global stubbed through a `window` cast", () => {
		// zustand tests/devtools.test.tsx:120 — module-level setup installs the
		// Redux DevTools extension hook, the extension's documented global.
		const content = ";(window as any).__REDUX_DEVTOOLS_EXTENSION__ = extensionConnector";
		expect(checkPrivateMemberTestAccess(content, ZUSTAND)).toEqual([]);
	});

	it("N2: zustand tests/devtools.test.tsx:145 — beforeEach removes the extension global", () => {
		// zustand tests/devtools.test.tsx:143-146 — 'no extension installed' path.
		const content = [
			"  beforeEach(() => {",
			"    savedConsoleWarn = console.warn",
			"    console.warn = vi.fn()",
			"    ;(window as any).__REDUX_DEVTOOLS_EXTENSION__ = undefined",
			"  })",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZUSTAND)).toEqual([]);
	});

	it("N3: zustand tests/devtools.test.tsx:149 — afterEach restores the extension global", () => {
		// zustand tests/devtools.test.tsx:147-150
		const content = [
			"  afterEach(() => {",
			"    console.warn = savedConsoleWarn",
			"    ;(window as any).__REDUX_DEVTOOLS_EXTENSION__ = extensionConnector",
			"  })",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZUSTAND)).toEqual([]);
	});

	it("N4: zustand tests/devtools.test.tsx:405 — attaching the declared `dispatch` interop hook through `as any`", () => {
		// zustand tests/devtools.test.tsx:402-406 — src/middleware/redux.ts:42
		// attaches `dispatch` with the identical `(api as any).dispatch = …` idiom;
		// devtools.ts:30-36 reads it through the `WithDispatch` type.
		const content = [
			"    it('does nothing even if there is `api.dispatch`', async () => {",
			"      const initialState = { count: 0 }",
			"      const api = createStore(devtools(() => initialState, { enabled: true }))",
			"      ;(api as any).dispatch = vi.fn()",
			"      const setState = vi.spyOn(api, 'setState')",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZUSTAND)).toEqual([]);
	});

	it("N5: zustand tests/devtools.test.tsx:416 — reading back the test-owned mock on the interop property", () => {
		// zustand tests/devtools.test.tsx:414-416
		const content = [
			"      expect(api.getState()).toBe(initialState)",
			"      expect(setState).not.toBeCalled()",
			"      expect((api as any).dispatch).not.toBeCalled()",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZUSTAND)).toEqual([]);
	});

	it("N6: zustand tests/devtools.test.tsx:422 — `dispatch` + `dispatchFromDevtools` interop contract simulated", () => {
		// zustand tests/devtools.test.tsx:421-423
		const content = [
			"      const api = createStore(devtools(() => initialState, { enabled: true }))",
			"      ;(api as any).dispatch = vi.fn()",
			"      ;(api as any).dispatchFromDevtools = true",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZUSTAND)).toEqual([]);
	});

	it("N7: zod detached-methods.test.ts:183 — narrowing an untyped dynamic result to call public `safeParse`", () => {
		// zod packages/zod/src/v4/classic/tests/detached-methods.test.ts:183
		const content =
			'      if (result && typeof result === "object" && "_zod" in result && typeof (result as any).safeParse === "function") {';
		expect(checkPrivateMemberTestAccess(content, ZOD_DETACHED)).toEqual([]);
	});

	it("N8: zod detached-methods.test.ts:185 — calling public `safeParse` on the untyped result", () => {
		// zod packages/zod/src/v4/classic/tests/detached-methods.test.ts:184-185
		const content = [
			'        const probeValue = target === stringSchema ? "x" : 1;',
			"        const r = (result as any).safeParse(probeValue);",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZOD_DETACHED)).toEqual([]);
	});

	it("N9: zod error-utils.test.ts:831 — `as any` bypasses optionality on the public `properties` field", () => {
		// zod packages/zod/src/v4/classic/tests/error-utils.test.ts:829-831 —
		// `$ZodErrorTree.properties?` is public but optional and dynamically keyed.
		const content = [
			"  expect(Object.getPrototypeOf(tree.properties)).toBe(Object.prototype);",
			'  expect((tree as any).properties[name].errors).toEqual(["invalid value"]);',
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZOD_ERROR_UTILS)).toEqual([]);
	});

	it("N10: zod error-utils.test.ts:906 — `as any` avoids a union-call error on public `safeParse`", () => {
		// zod packages/zod/src/v4/classic/tests/error-utils.test.ts:906 —
		// `schema` is one of three ZodObject types from an `as const` tuple.
		const content = [
			"    const result = (schema as any).safeParse(input);",
			"    expect(result.success).toBe(false);",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZOD_ERROR_UTILS)).toEqual([]);
	});

	it("N11: zod error.test.ts:1017 — writing the public `error` field to prove the result is plain data", () => {
		// zod packages/zod/src/v4/classic/tests/error.test.ts:1011-1018
		const content = [
			'  test("result stays plain data", () => {',
			"    const result = z.string().safeParse(1);",
			"    const replaced = new z.ZodError([]);",
			"    (result as any).error = replaced;",
			"    expect(result.error).toBe(replaced);",
			"  });",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZOD_ERROR)).toEqual([]);
	});

	it("N12: a dunder on a bare host-global receiver (no cast) is environment stubbing", () => {
		// Same class as N1–N3 without the cast: the receiver, not the cast, decides.
		const content = ["window.__REDUX_DEVTOOLS_EXTENSION__ = stub", "globalThis.__coverage__ = {}"].join("\n");
		expect(checkPrivateMemberTestAccess(content, TEST)).toEqual([]);
	});

	it("N13: a bracket dunder on a host global is environment stubbing", () => {
		const content = 'window["__REDUX_DEVTOOLS_EXTENSION__"] = stub;';
		expect(checkPrivateMemberTestAccess(content, TEST)).toEqual([]);
	});
});

describe("private_member_test_access — positive (must fire)", () => {
	it("P1: `(api as any)._queue` — an underscore-prefixed member through `as any` still fires", () => {
		const content = "(api as any)._queue.push(action);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P2: `(result as any).internalIssues` — a private-looking name through `as any` still fires", () => {
		const content = "expect((result as any).internalIssues).toHaveLength(0);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P3: `(store as any).__listeners` — a dunder through `as any` on a non-global still fires", () => {
		const content = "(store as any).__listeners.clear();";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P4: `window.store.__internal` — only a DIRECT host-global receiver is exempt", () => {
		const content = "window.store.__internal = 1;";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P5: `(tree as unknown as { _props: Map })._props` — a structural cast to a hidden shape still fires", () => {
		const content = "(tree as unknown as { _props: Map<string, unknown> })._props.clear();";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P6: `(schema as unknown as ZodInternals).safeParse` — a public NAME does not exempt the named-type reach", () => {
		const content = "(schema as unknown as ZodInternals).safeParse(input);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P7: `svc[\"__privateMap\"]` — a bracket dunder on a non-global receiver still fires", () => {
		const content = 'svc["__privateMap"].set("k", 1);';
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P8: one public-member cast and one private reach on the same line still fire once", () => {
		const content = "expect((api as any).dispatch).toBe((api as any)._dispatchImpl);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	// Verifier (2026-10-21 refine-result.json): the name-only `as any` rule and
	// the unguarded host-global receiver exempted more than the blind spot.
	it("P9: repair — `(svc as any).cache.clear()`: an ordinary-named member read and chained", () => {
		const content = "(svc as any).cache.clear();";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P10: repair — `expect((svc as any).state.items)`: an asserted chained read of a hidden field", () => {
		const content = "expect((svc as any).state.items).toHaveLength(2);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P11: repair — `(svc as any).pendingRequests.size`: an ordinary-named TS private field", () => {
		const content = "expect((svc as any).pendingRequests.size).toBe(0);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P12: repair — `(svc as any).client = fakeClient`: replacing a field with a non-mock, non-literal value", () => {
		const content = "(svc as any).client = fakeClient;";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P13: repair — `obj.window.__secret = 1`: a MEMBER named like a host global is not a host global", () => {
		const content = "obj.window.__secret = 1;";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P14: repair — `store.self.__cache.get(k)`: a member named `self` is not a host global", () => {
		const content = "store.self.__cache.get(k);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P15: repair — `foo.window[\"__X\"] = 1`: a bracket dunder on a member named `window`", () => {
		const content = 'foo.window["__X"] = 1;';
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P16: repair — `(globalThis as any).__myLibInternal.reset()`: a SUT dunder on a global is used, not stubbed", () => {
		const content = "(globalThis as any).__myLibInternal.reset();";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P17: repair — `self.__privateCache.clear()`: a dunder call on `self` (often `const self = this`)", () => {
		const content = "self.__privateCache.clear();";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});

	it("P18: repair — `process.__secret.value`: a chained read of a dunder on `process`", () => {
		const content = "const v = process.__secret.value;";
		expect(checkPrivateMemberTestAccess(content, TEST)).toHaveLength(1);
	});
});

describe("private_member_test_access — negative (must not fire), repair round", () => {
	it("N14: `(svc as any).isPrivateMode()` — a public query whose name contains `Private` mid-word", () => {
		const content = "expect((svc as any).isPrivateMode()).toBe(false);";
		expect(checkPrivateMemberTestAccess(content, TEST)).toEqual([]);
	});

	it("N15: zod object.test.ts:678 — an absence probe: the stripped key must be undefined", () => {
		// zod packages/zod/src/v4/classic/tests/object.test.ts:678
		const content = "    expect((parsed as any).isAdmin).toBeUndefined();";
		expect(checkPrivateMemberTestAccess(content, ZOD_ERROR)).toEqual([]);
	});

	it("N16: zod instance-footprint.test.ts:260 — `delete` of a member the file reads without a cast", () => {
		// zod packages/zod/src/v4/classic/tests/instance-footprint.test.ts:259-261
		const content = [
			"  // and, like every prototype member, recomputes after deletion rather than staying absent",
			"  delete (derived as any).minValue;",
			"  expect(derived.minValue).toBe(2);",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZOD_ERROR)).toEqual([]);
	});

	it("N17: zustand devtools.test.tsx:434,764 — calling and asserting the interop `dispatch` mock", () => {
		// zustand tests/devtools.test.tsx:434 and :764
		const content = [
			"      expect((api as any).dispatch).toHaveBeenLastCalledWith({",
			"    ;(api as any).dispatch({ type: 'INCREMENT' })",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, ZUSTAND)).toEqual([]);
	});

	it("N18: zod object.test.ts:831 — the `(` of `pick(mask as any)` is a call paren, not a cast receiver", () => {
		// zod packages/zod/src/v4/classic/tests/object.test.ts:831 — `.shape` is on the call result.
		const content =
			"    expect(() => z.object({ value: z.string() }).pick(mask as any).shape).toThrow('Unrecognized key: \"__proto__\"');";
		expect(checkPrivateMemberTestAccess(content, ZOD_ERROR)).toEqual([]);
	});
});
