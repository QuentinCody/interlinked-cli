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

export function wireNullable<T>(validate: WireValidator<T>): WireValidator<T | null> {
	return (value): value is T | null => value === null || validate(value);
}

export function parseWire<T>(value: unknown, validate: WireValidator<T>, label: string): T {
	if (!validate(value)) throw new Error(`Invalid ${label}`);
	return value;
}

export function wireArray<T>(validate: WireValidator<T>): WireValidator<T[]> {
	return (value): value is T[] => Array.isArray(value) && value.every(validate);
}

export function wireRecord<T>(validate: WireValidator<T>): WireValidator<Record<string, T>> {
	return (value): value is Record<string, T> => isJsonObject(value) && Object.values(value).every(validate);
}

/** Require a validator for every declared field, including optional fields.
 * Unknown extra fields remain allowed for protocol forward compatibility. */
export function wireObject<T extends object>(fields: {
	[K in keyof T]-?: WireValidator<T[K]>;
}): WireValidator<T> {
	const entries = Object.entries<WireValidator<unknown>>(fields);
	return (value): value is T => isJsonObject(value) && entries.every(([key, validate]) => validate(value[key]));
}
