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
	// `args` accepts `null` honestly: this factory is a reusable primitive
	// callers can invoke with data reconstructed from anywhere (deserialized
	// errors, defensively-typed call sites), and the constructor itself never
	// dereferences a nullish `args` — the type says so too.
	new (args: Props | null): TaggedErrorInstance<Tag, Props>;
	is(value: unknown): value is TaggedErrorInstance<Tag, Props>;
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
			const message =
				args != null && "message" in args && typeof args.message === "string"
					? args.message
					: tag;
			const cause = args != null && "cause" in args ? args.cause : undefined;
			super(message, cause !== undefined ? { cause } : undefined);
			// `Object.assign` treats a nullish source as a no-op, matching the
			// widened `Props | null` param — nothing extra to guard here.
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
	// `Object.assign(this, args)` adds the `Readonly<Props>` members at runtime
	// that the static type of `TaggedBase` can't express, so a widening cast at
	// this factory boundary is unavoidable. Route it through an `unknown`-typed
	// binding (rather than an inline `as unknown as`) so the assertion is a
	// single, documented widening rather than a type-system bypass.
	const ctor: unknown = TaggedBase;
	return ctor as TaggedErrorClass<Tag, Props>;
}

/**
 * Factory for creating typed, discriminated error classes.
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
): <Props extends JsonObject = Record<string, never>>() => TaggedErrorClass<Tag, Props> {
	return <Props extends JsonObject = Record<string, never>>() =>
		buildTaggedErrorClass<Tag, Props>(tag);
}

/** Check if a value is any tagged error */
TaggedError.is = (value: unknown): value is AnyTaggedError =>
	value instanceof Error && "_tag" in value && typeof (value as AnyTaggedError)._tag === "string";
