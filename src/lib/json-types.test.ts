// ===========================================
// JSON Value Types — tests
// ===========================================

import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "./json-types.js";

describe("json-types", () => {
	it("accepts primitive JSON values assigned to JsonValue", () => {
		const a: JsonValue = "hello";
		const b: JsonValue = 42;
		const c: JsonValue = true;
		const d: JsonValue = null;
		expect([a, b, c, d]).toStrictEqual(["hello", 42, true, null]);
	});

	it("accepts nested objects and arrays as JsonObject values", () => {
		const obj: JsonObject = {
			name: "x",
			count: 3,
			active: false,
			nested: { inner: [1, 2, 3] },
			items: ["a", "b"],
		};
		expect(obj.name).toBe("x");
		expect(obj.nested).toHaveProperty("inner", [1, 2, 3]);
		expect(obj.items).toHaveLength(2);
	});

	it("round-trips through JSON.parse / JSON.stringify", () => {
		const input: JsonObject = { a: 1, b: "two", c: [true, null] };
		const serialised = JSON.stringify(input);
		const parsed: unknown = JSON.parse(serialised);
		expect(parsed).toStrictEqual(input);
	});
});
