import { describe, expect, expectTypeOf, it } from "vitest";
import { parseWire, type SupportedWireObject, wireAbsentOptional, wireArray, wireObject, wireOptional, wireString, wireUnknown } from "./value-validation.js";

describe("wire object property presence", () => {
	it("validates sparse array positions as undefined", () => {
		const sparse: unknown[] = new Array(1);
		expect(wireArray(wireString)(sparse)).toBe(false);
		expect(wireArray(wireString)(["present"])).toBe(true);
		expect(wireArray(wireOptional(wireString))(sparse)).toBe(true);
	});
	it("requires an unknown-valued property to exist", () => {
		const validate = wireObject<{ payload: unknown }>({ payload: wireUnknown });
		expect(validate({})).toBe(false);
		expect(validate({ payload: undefined })).toBe(true);
		expect(validate({ payload: null })).toBe(true);
	});

	it("distinguishes strict optional absence from present undefined", () => {
		const validate = wireObject<{ name?: string }>({ name: wireAbsentOptional(wireString) });
		expect(validate({})).toBe(true);
		expect(validate({ name: "agent" })).toBe(true);
		expect(validate({ name: undefined })).toBe(false);
		expect(validate({ name: null })).toBe(false);
	});

	it("preserves explicitly allowed undefined on optional and required fields", () => {
		const optional = wireObject<{ name?: string | undefined }>({ name: wireAbsentOptional(wireOptional(wireString)) });
		const required = wireObject<{ name: string | undefined }>({ name: wireOptional(wireString) });
		expect(optional({})).toBe(true);
		expect(optional({ name: undefined })).toBe(true);
		expect(required({})).toBe(false);
		expect(required({ name: undefined })).toBe(true);
	});

	it("infers optional properties without widening required or strict optional values", () => {
		const validate = wireObject({ id: wireString, name: wireAbsentOptional(wireString) });
		const value = parseWire({ id: "event" }, validate, "event");
		expectTypeOf(value).toEqualTypeOf<{ id: string } & { name?: string }>();
		expect(validate({ id: undefined })).toBe(false);
		expect(validate({ id: "event", name: undefined })).toBe(false);
	});

	it("checks inherited values and preserves extra evidence", () => {
		const validate = wireObject({ id: wireString, name: wireAbsentOptional(wireString) });
		const value: unknown = Object.assign(Object.create({ id: "inherited" }), { extra: 42 });
		expect(parseWire(value, validate, "event")).toBe(value);
		expect(validate(Object.create({ id: "inherited", name: undefined }))).toBe(false);
	});

	it("allows unknown extension fields while checking declared named fields", () => {
		expectTypeOf<SupportedWireObject<Record<string, string>>>().toBeNever();
		expectTypeOf<SupportedWireObject<Record<number, number>>>().toBeNever();
		expectTypeOf<SupportedWireObject<Record<`item:${string}`, string>>>().toBeNever();
		expectTypeOf<SupportedWireObject<Record<symbol, string>>>().toBeNever();
		const validate = wireObject<{ [key: string]: unknown; id: string }>({ id: wireString });
		expect(validate({ id: "event", future: { evidence: 1 } })).toBe(true);
		expect(validate({ future: true })).toBe(false);
		expect(validate({ id: undefined })).toBe(false);
	});
});
