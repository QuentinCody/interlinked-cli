import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	bindSimplificationAgentCiHandoff,
	canonicalSimplificationAgentCiJson,
	compareCodeUnits,
	deepFreeze,
} from "./simplification-agent-ci-request-canonical.js";

describe("canonicalSimplificationAgentCiJson", () => {
	it("sorts object keys recursively", () => {
		expect(canonicalSimplificationAgentCiJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}',
		);
	});

	it("keeps array order and encodes primitives", () => {
		expect(canonicalSimplificationAgentCiJson([2, 1, "x", true, null])).toBe('[2,1,"x",true,null]');
	});

	it("rejects a non-finite number", () => {
		expect(() => canonicalSimplificationAgentCiJson({ n: Number.NaN })).toThrow(TypeError);
	});

	it("rejects a value that is not JSON-compatible", () => {
		expect(() => canonicalSimplificationAgentCiJson(() => undefined)).toThrow(TypeError);
	});

	it("is a stable identity input", () => {
		const digest = createHash("sha256")
			.update(canonicalSimplificationAgentCiJson({ a: 1 }), "utf8")
			.digest("hex");
		expect(digest).toHaveLength(64);
	});
});

describe("compareCodeUnits", () => {
	it("orders by code unit and reports equality as zero", () => {
		expect(compareCodeUnits("a", "b")).toBe(-1);
		expect(compareCodeUnits("b", "a")).toBe(1);
		expect(compareCodeUnits("a", "a")).toBe(0);
	});
});

describe("deepFreeze", () => {
	it("freezes nested members", () => {
		const value = deepFreeze({ nested: { list: [1] } });
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.nested)).toBe(true);
		expect(Object.isFrozen(value.nested.list)).toBe(true);
	});

	it("returns a primitive unchanged", () => {
		expect(deepFreeze(7)).toBe(7);
	});
});

describe("bindSimplificationAgentCiHandoff", () => {
	it("refuses input that is not a local deep handoff", () => {
		expect(bindSimplificationAgentCiHandoff({ not: "a handoff" })).toEqual({
			ok: false,
			reason: "invalid local simplification deep handoff",
		});
	});
});
