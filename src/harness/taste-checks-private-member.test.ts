// Companion test for taste-checks-private-member.ts. The full cross-repo
// evidence lives in __tests__/adversarial/private_member_test_access.foreign.test.ts;
// this file pins the module's own entry point and its shape rules.

import { describe, expect, it } from "vitest";
import { checkPrivateMemberTestAccess } from "./taste-checks-private-member.js";

const TEST = "/repo/src/widget.test.ts";

describe("checkPrivateMemberTestAccess — positive (must fire)", () => {
	it("P1: a chained read of an ordinary-named member through `as any`", () => {
		expect(checkPrivateMemberTestAccess("(svc as any).cache.clear();", TEST)).toHaveLength(1);
	});

	it("P2: a write of a non-literal value through `as any`", () => {
		expect(checkPrivateMemberTestAccess("(svc as any).client = fake;", TEST)).toHaveLength(1);
	});

	it("P3: a private-looking member through `as any`, even in an exempt shape", () => {
		expect(checkPrivateMemberTestAccess("(svc as any)._reset();", TEST)).toHaveLength(1);
	});

	it("P4: a call through a dunder on a host global", () => {
		expect(checkPrivateMemberTestAccess("window.__store.reset();", TEST)).toHaveLength(1);
	});

	it("P5: a bracket dunder write on a member named `window`", () => {
		expect(checkPrivateMemberTestAccess('foo.window["__X"] = 1;', TEST)).toHaveLength(1);
	});
});

describe("checkPrivateMemberTestAccess — negative (must not fire)", () => {
	it("N1: a direct public method call through `as any`", () => {
		expect(checkPrivateMemberTestAccess("(schema as any).safeParse(input);", TEST)).toEqual([]);
	});

	it("N2: a typeof feature probe", () => {
		expect(checkPrivateMemberTestAccess('if (typeof (r as any).parse === "function") {}', TEST)).toEqual([]);
	});

	it("N3: attaching a mock and asserting it", () => {
		const content = ["(api as any).dispatch = vi.fn();", "expect((api as any).dispatch).not.toBeCalled();"].join("\n");
		expect(checkPrivateMemberTestAccess(content, TEST)).toEqual([]);
	});

	it("N4: an absence probe", () => {
		expect(checkPrivateMemberTestAccess("expect((parsed as any).isAdmin).toBeUndefined();", TEST)).toEqual([]);
	});

	it("N5: a member the file also reads without a cast", () => {
		const content = ["(result as any).error = replaced;", "expect(result.error).toBe(replaced);"].join("\n");
		expect(checkPrivateMemberTestAccess(content, TEST)).toEqual([]);
	});

	it("N6: a dunder write and a bracket dunder write on bare host globals", () => {
		const content = ["window.__DEVTOOLS__ = stub;", 'window["__DEVTOOLS__"] = stub;'].join("\n");
		expect(checkPrivateMemberTestAccess(content, TEST)).toEqual([]);
	});

	it("N7: a non-test file is never scanned", () => {
		expect(checkPrivateMemberTestAccess("(svc as any).cache.clear();", "/repo/src/widget.ts")).toEqual([]);
	});
});
