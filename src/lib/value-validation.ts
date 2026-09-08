import { isJsonObject } from "./json-types.js";

/** Validators accept foreign JSON and prove precisely the value they retain. */
export type WireValidator<T> = (value: unknown) => value is T;

export const wireString: WireValidator<string> = (value) => typeof value === "string";
export const wireNumber: WireValidator<number> = (value): value is number => typeof value === "number" && Number.isFinite(value);
export const wireBoolean: WireValidator<boolean> = (value) => typeof value === "boolean";
export const wireUnknown: WireValidator<unknown> = (_value): _value is unknown => true;

export function wireLiteral<const T extends readonly (string | boolean | number)[]>(...values: T): WireValidator<T[number]> {
	return (value): value is T[number] => values.some((candidate) => candidate === value);
}

export function wireOptional<T>(validate: WireValidator<T>): WireValidator<T | undefined> {
	return (value): value is T | undefined => value === undefined || validate(value);
}

export interface AbsentWireValidator<T> {
	readonly present: WireValidator<T>;
}

/** Allow an omitted object property while validating every present value. */
export function wireAbsentOptional<T>(validate: WireValidator<T>): AbsentWireValidator<T> {
	return { present: validate };
}

export function wireNullable<T>(validate: WireValidator<T>): WireValidator<T | null> {
	return (value): value is T | null => value === null || validate(value);
}

export function parseWire<T>(value: unknown, validate: WireValidator<T>, label: string): T {
	if (!validate(value)) throw new Error(`Invalid ${label}`);
	return value;
}

export function wireArray<T>(validate: WireValidator<T>): WireValidator<T[]> {
	return (value): value is T[] => {
		if (!Array.isArray(value)) return false;
		for (let index = 0; index < value.length; index++) if (!validate(value[index])) return false;
		return true;
	};
}

export function wireRecord<T>(validate: WireValidator<T>): WireValidator<Record<string, T>> {
	return (value): value is Record<string, T> => isJsonObject(value)
		&& hasDictionaryPrototype(value)
		&& Object.getOwnPropertyNames(value).every((key) => validate(value[key]));
}

function hasDictionaryPrototype(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export type WireFields = Record<string, WireValidator<unknown> | AbsentWireValidator<unknown>>;
type WireFieldValue<F> = F extends WireValidator<infer T> | AbsentWireValidator<infer T> ? T : never;
export type InferredWireObject<F extends WireFields> = {
	[K in keyof F as F[K] extends AbsentWireValidator<unknown> ? never : K]: WireFieldValue<F[K]>;
} & {
	[K in keyof F as F[K] extends AbsentWireValidator<unknown> ? K : never]?: WireFieldValue<F[K]>;
};
type NarrowIndexKeys<T> = {
	[K in keyof T]-?: {} extends Record<K, unknown> ? unknown extends T[K] ? never : K : never;
}[keyof T];
/** Open extra keys are safe only when their values are unknown. Use wireRecord
 * to validate every value of a narrower index signature. */
type UnsupportedWireObjectMember<T> = Extract<keyof T, symbol> extends never
	? [NarrowIndexKeys<T>] extends [never] ? never : T
	: T;
export type SupportedWireObject<T> = [T extends unknown ? UnsupportedWireObjectMember<T> : never] extends [never] ? unknown : never;

/** Capture all own validators; inherited schema declarations are unsupported. */
function schemaEntries(fields: WireFields): Array<[string, WireValidator<unknown> | AbsentWireValidator<unknown>]> {
	if (!hasDictionaryPrototype(fields)) throw new TypeError("Wire schemas must use a plain or null-prototype object");
	const entries: Array<[string, WireValidator<unknown> | AbsentWireValidator<unknown>]> = [];
	for (const key of Object.getOwnPropertyNames(fields)) {
		const validate = fields[key];
		if (validate === undefined) throw new TypeError(`Wire schema field ${key} has no validator`);
		entries.push([key, validate]);
	}
	return entries;
}

/** Require every declared field unless its schema explicitly permits absence.
 * Present inherited fields are validated just like own fields; extra fields remain allowed. */
export function wireObject<F extends WireFields>(fields: F & SupportedWireObject<InferredWireObject<F>>): WireValidator<InferredWireObject<F>>;
export function wireObject<T extends object>(fields: {
	[K in keyof T as {} extends Record<K, unknown> ? never : K]-?: {} extends Pick<T, K> ? AbsentWireValidator<Required<T>[K]> : WireValidator<T[K]>;
} & SupportedWireObject<T>): WireValidator<T>;
export function wireObject(fields: WireFields): WireValidator<object> {
	const entries = schemaEntries(fields);
	return (value): value is object => isJsonObject(value) && entries.every(([key, validate]) =>
		typeof validate === "function" ? key in value && validate(value[key]) : !(key in value) || validate.present(value[key]));
}
