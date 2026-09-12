// interlinked-tdd: exempt
import type { JsonObject } from "../lib/json-types.js";

// ===========================================
// TaggedError Factory
// ===========================================

/** Type for any tagged error instance */
export type AnyTaggedError = Error & { readonly _tag: string };

/** Instance type produced by TaggedError factory */
export type TaggedErrorInstance<Tag extends string, Props> = Error & {
	readonly _tag: Tag;
	toJSON(): JsonObject;
} & Readonly<Props>;

/** Class type produced by TaggedError factory */
export interface TaggedErrorClass<Tag extends string, Props> {
	/** Null is allowed only when an empty object satisfies the declared properties. */
	new (args: Props | ({} extends Props ? null : never)): TaggedErrorInstance<Tag, Props>;
	is(value: unknown): value is TaggedErrorInstance<Tag, Props>;
}

const reservedTaggedFields = ["_tag", "name", "stack", "toJSON", "toString", "constructor", "__proto__"] as const;
type ReservedTaggedField = typeof reservedTaggedFields[number];
type UnsupportedTaggedKeys<Props> = {
	[K in keyof Props]-?: {} extends Record<K, unknown> ? K : K extends ReservedTaggedField ? K : never;
}[keyof Props];
type TaggedPropsMemberSupported<Props> = [UnsupportedTaggedKeys<Props>] extends [never]
	? "message" extends keyof Props ? Required<Props>["message"] extends string ? true : false : true
	: false;
type TaggedPropsSupported<Props> = false extends (Props extends unknown ? TaggedPropsMemberSupported<Props> : never) ? false : true;

/** Structural types also admit inherited or hidden fields, which Object.assign cannot copy. */
function assertCopyableTaggedArgs(args: JsonObject | null): void {
	if (args === null) return;
	// Boxed primitives and functions also fail the plain-prototype check below.
	const prototype = Object.getPrototypeOf(args);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("TaggedError arguments must be a plain object");
	}
	for (const key of Reflect.ownKeys(args)) {
		if (reservedTaggedFields.some((reserved) => key === reserved)) {
			throw new TypeError(`TaggedError property ${String(key)} is reserved`);
		}
		if (!Object.getOwnPropertyDescriptor(args, key)?.enumerable) {
			throw new TypeError(`TaggedError property ${String(key)} must be enumerable`);
		}
	}
	if ("message" in args && typeof args.message !== "string") {
		throw new TypeError("TaggedError message must be a string");
	}
}

/** Build the inner class for a tagged error — extracted to reduce nesting */
function buildTaggedErrorClass<Tag extends string, Props extends JsonObject>(
	tag: Tag,
): TaggedErrorClass<Tag, Props> {
	class TaggedBase extends Error {
		readonly _tag: Tag = tag;

		static is(value: unknown): value is TaggedBase {
			return value instanceof TaggedBase;
		}

		constructor(args: Props | null) {
			assertCopyableTaggedArgs(args);
			const message =
				args != null && "message" in args && typeof args.message === "string"
					? args.message
					: tag;
			const cause = args != null && "cause" in args ? args.cause : undefined;
			super(message, cause !== undefined ? { cause } : undefined);
			// Checked plain, enumerable properties cannot be lost during copying.
			Object.assign(this, args);
			Object.setPrototypeOf(this, new.target.prototype);
			this.name = tag;
			if (cause instanceof Error && cause.stack) {
				this.stack = `${this.stack}\nCaused by: ${cause.stack.replace(/\n/g, "\n  ")}`;
			}
		}

		toJSON(): JsonObject {
			const json: JsonObject = {
				_tag: this._tag,
				name: this.name,
				message: this.message,
				stack: this.stack,
			};
			// Copy the own-enumerable props added via `Object.assign(this, args)`.
			// `Reflect.get` reads each by key without a structural cast on `this`.
			for (const key of Object.keys(this)) {
				json[key] = Reflect.get(this, key);
			}
			return json;
		}
	}
	// SAFETY: the factory rejects indexed/reserved Props and non-string messages; the constructor rejects inherited/hidden fields before copying every own enumerable member. Null is exposed only for empty-compatible Props.
	return TaggedBase as unknown as TaggedErrorClass<Tag, Props>;
}

/**
 * Factory for creating typed, discriminated error classes.
 * Props must use named data fields; arguments must be plain objects with
 * enumerable properties. Error identity/stack methods belong to the factory.
 *
 * @example
 * ```ts
 * class NotFoundError extends TaggedError("NotFoundError")<{ path: string }>() {}
 * const e = new NotFoundError({ path: "/foo" });
 * e._tag  // "NotFoundError"
 * e.path  // "/foo"
 * ```
 */
export function TaggedError<Tag extends string>(
	tag: Tag,
): <Props extends JsonObject = {}>(...invalid: TaggedPropsSupported<Props> extends true ? [] : [never]) => TaggedErrorClass<Tag, Props> {
	return <Props extends JsonObject = {}>(..._invalid: TaggedPropsSupported<Props> extends true ? [] : [never]) =>
		buildTaggedErrorClass<Tag, Props>(tag);
}

/** Check if a value is any tagged error */
TaggedError.is = (value: unknown): value is AnyTaggedError =>
	value instanceof Error && "_tag" in value && typeof value._tag === "string";
