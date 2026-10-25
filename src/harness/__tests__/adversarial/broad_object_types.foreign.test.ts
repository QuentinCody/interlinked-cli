// Cross-repo falsification of the `broad_object_types` pre_warn check
// (2026-10-21, scratch/2026-10-21-cross-repo/falsify-result.json). Every
// negative below is REAL code from a foreign repository (zod, zustand) that
// an independent adjudication confirmed as a false positive: the bare
// `object` sat where no shape existed to hide. Each is attributed to its
// source file:line and trimmed to the lines the detector reads. The positives
// pin the bug class so the refinement cannot become a blanket exemption of
// bare `object`.
import { describe, expect, it } from "vitest";
import { checkBroadObjectTypes } from "../../checks/agent-safety-js-correctness.js";

describe("broad_object_types — negative (must not fire)", () => {
	it("N1: zustand src/middleware/persist.ts:195 — `as object` narrows an `unknown` value only far enough to spread it", () => {
		// zustand/src/middleware/persist.ts lines 190-198 (persistImpl defaults).
		const content = [
			"const persistImpl: PersistImpl = (config, baseOptions) => (set, get, api) => {",
			"  type S = ReturnType<typeof config>",
			"  let options = {",
			"    storage: createJSONStorage<S, void>(() => window.localStorage),",
			"    partialize: (state: S) => state,",
			"    version: 0,",
			"    merge: (persistedState: unknown, currentState: S) => ({",
			"      ...currentState,",
			"      ...(persistedState as object),",
			"    }),",
			"    ...baseOptions,",
			"  }",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/middleware/persist.ts")).toEqual([]);
	});

	it("N2: zustand src/vanilla/shallow.ts:1 — `object` is the input of a type-guard predicate that narrows it", () => {
		// zustand/src/vanilla/shallow.ts lines 1-2.
		const content = [
			"const isIterable = (obj: object): obj is Iterable<unknown> =>",
			"  Symbol.iterator in obj",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/vanilla/shallow.ts")).toEqual([]);
	});

	it("N3: zod packages/zod/src/v3/types.ts:5117 — `objectType as object` is an export rename specifier, not an assertion", () => {
		// zod/packages/zod/src/v3/types.ts lines 5108-5120 (the `export { … }` tail).
		const content = [
			"export {",
			"  lazyType as lazy,",
			"  literalType as literal,",
			"  mapType as map,",
			"  nanType as nan,",
			"  nativeEnumType as nativeEnum,",
			"  neverType as never,",
			"  nullType as null,",
			"  nullableType as nullable,",
			"  numberType as number,",
			"  objectType as object,",
			"  oboolean,",
			"  onumber,",
			"  optionalType as optional,",
			"};",
		].join("\n");
		expect(checkBroadObjectTypes(content, "packages/zod/src/v3/types.ts")).toEqual([]);
	});

	it("N4: zod packages/zod/src/v4/classic/errors.ts:35 — `proto: object` is a reflection target (Object.defineProperty / WeakSet<object>)", () => {
		// zod/packages/zod/src/v4/classic/errors.ts lines 28-45.
		const content = [
			"const _installedErrorProtos = /* @__PURE__ */ new WeakSet<object>([Object.prototype, Error.prototype]);",
			"",
			"function _lazyMethod(proto: object, key: string, make: (self: ZodError) => unknown): void {",
			"  Object.defineProperty(proto, key, {",
			"    configurable: true,",
			"    enumerable: false,",
			"    get(this: ZodError) {",
			"      const value = make(this);",
			"      Object.defineProperty(this, key, { value, configurable: true, writable: true });",
			"      return value;",
			"    },",
			"    set(this: ZodError, value: unknown) {",
			"      Object.defineProperty(this, key, { value, configurable: true, writable: true });",
			"    },",
			"  });",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "packages/zod/src/v4/classic/errors.ts")).toEqual([]);
	});

	it("N5: zod packages/zod/src/v4/classic/from-json-schema.ts:231,232,243 — `as object` casts of a runtime-checked `unknown` JSON value passed to Set<object> / Object.keys", () => {
		// zod/packages/zod/src/v4/classic/from-json-schema.ts lines 223-243 (canonicalKey).
		const content = [
			"function canonicalKey(value: unknown, seen: Set<object>): string | null {",
			'  if (value === null) return "z";',
			"  const type = typeof value;",
			'  if (type !== "object") {',
			'    if (type === "number" && Number.isNaN(value)) return null;',
			"    const raw = String(value);",
			"    return `${type[0]}${raw.length}:${raw}`;",
			"  }",
			"  if (seen.has(value as object)) return null;",
			"  seen.add(value as object);",
			"  try {",
			"    if (Array.isArray(value)) {",
			"      const parts: string[] = [];",
			"      return `a${parts.length}:[${parts.join(\",\")}]`;",
			"    }",
			"    const keys = Object.keys(value as object).sort();",
			"    return keys.join(\",\");",
			"  } finally {",
			"    seen.delete(value as object);",
			"  }",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "packages/zod/src/v4/classic/from-json-schema.ts")).toEqual([]);
	});

	it("N6: the cast-consumer class without an `unknown` declaration in scope (spread / membership on the same line)", () => {
		// Same class as N1/N5 when the operand's `unknown` type is inferred rather
		// than written (a generic `T` or an `any`-returning parser): the consumer
		// on the line is what demands `object`.
		const content = [
			"function dedupe<T>(items: T[]) {",
			"  const seen = new WeakSet<object>();",
			"  return items.filter((item) => !seen.has(item as object));",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/dedupe.ts")).toEqual([]);
	});
});

describe("broad_object_types — positive (must fire)", () => {
	it("P1: a parameter typed `object` whose body forwards it with no reflection use — the shape is hidden", () => {
		const content = ["export function render(props: object) {", "  return template(props);", "}"].join("\n");
		expect(checkBroadObjectTypes(content, "src/render.ts").length).toBe(1);
	});

	it("P2: `as object` that widens a value with a declared shape and stores it", () => {
		const content = [
			"function load(user: User) {",
			"  const record = user as object;",
			"  return record;",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/load.ts").length).toBe(1);
	});

	it("P3: a reflection use in a DIFFERENT function does not exempt an unrelated `object` parameter", () => {
		const content = [
			"export function describe(entity: object) {",
			"  return format(entity);",
			"}",
			"",
			"export function keysOf(entity: object) {",
			"  return Object.keys(entity);",
			"}",
		].join("\n");
		const hits = checkBroadObjectTypes(content, "src/describe.ts");
		expect(hits.map((h) => h.line)).toEqual([1]);
	});

	it("P4: a type-guard elsewhere in the file does not exempt a plain `object` parameter", () => {
		const content = [
			"const isIterable = (obj: object): obj is Iterable<unknown> => Symbol.iterator in obj;",
			"",
			"export function serialize(payload: object) {",
			"  return JSON.stringify(payload);",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/serialize.ts").map((h) => h.line)).toEqual([3]);
	});

	it("P5: `Record<string, any>`, index-signature-to-any and bare `Function` are untouched by the refinement", () => {
		const content = [
			"export type Props = Record<string, any>;",
			"export type Bag = { [k: string]: any };",
			"export function call(cb: Function) { cb(); }",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/types.ts").length).toBe(3);
	});

	it("P6: a real `as object` cast on an export line that is not a specifier list still fires", () => {
		const content = "export const settings = loadSettings() as object;";
		expect(checkBroadObjectTypes(content, "src/settings.ts").length).toBe(1);
	});

	it("P7: a same-named `unknown` parameter in ANOTHER function does not exempt a cast of a typed value", () => {
		const content = [
			"function parse(value: unknown) {",
			"  return typeof value;",
			"}",
			"",
			"function store(value: User) {",
			"  const record = value as object;",
			"  return record;",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/store.ts").map((h) => h.line)).toEqual([6]);
	});

	it("P8: repair — an options-bag parameter typed `object` that the body spreads still fires", () => {
		const content = [
			"export function configure(opts: object) {",
			"  return { ...defaults, ...opts };",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/configure.ts").map((h) => h.line)).toEqual([1]);
	});

	it("P9: repair — a type-guard declared on the FOLLOWING lines does not exempt a plain `object` parameter", () => {
		const content = [
			"export function apply(x: object): void { run(x); }",
			"const isFoo = (y: unknown): y is Foo =>",
			"  typeof y === \"object\";",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/apply.ts").map((h) => h.line)).toEqual([1]);
	});

	it("P10: repair — a parameter used reflectively AND read for a property still fires", () => {
		const content = [
			"export function timeoutOf(cfg: object) {",
			"  Object.keys(cfg);",
			"  return (cfg as any).timeout;",
			"}",
		].join("\n");
		expect(checkBroadObjectTypes(content, "src/timeout.ts").map((h) => h.line)).toEqual([1]);
	});
});
