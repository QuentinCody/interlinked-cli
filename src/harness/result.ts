import type {
	AnyTaggedError,
	TaggedErrorClass,
	TaggedErrorInstance,
} from "./result-tagged-error.js";

export { TaggedError } from "./result-tagged-error.js";
export type { AnyTaggedError, TaggedErrorClass, TaggedErrorInstance };
// ===========================================
// Result<T, E> — Rust-style error handling for TypeScript
// ===========================================
// Inlined from better-result patterns (zero dependencies).
// Discriminated union making errors explicit, composable,
// and impossible to silently ignore.

// ===========================================
// Error Types
// ===========================================

/** Programming defect — should never be caught. Indicates a bug in the caller. */
export class Panic extends Error {
	readonly _tag = "Panic" as const;
	constructor(message: string, cause?: unknown) {
		super(message, cause !== undefined ? { cause } : undefined);
		this.name = "Panic";
	}
}

/** Unknown error wrapped from a catch block */
export class UnhandledException extends Error {
	readonly _tag = "UnhandledException" as const;
	constructor(cause: unknown) {
		const message =
			cause instanceof Error
				? `Unhandled exception: ${cause.message}`
				: `Unhandled exception: ${String(cause)}`;
		super(message, { cause });
		this.name = "UnhandledException";
	}
}

/** Deserialization failure */
export class ResultDeserializationError extends Error {
	readonly _tag = "ResultDeserializationError" as const;
	readonly value: unknown;
	constructor(value: unknown) {
		super(
			'Failed to deserialize value as Result: expected { status: "ok", value } or { status: "error", error }',
		);
		this.name = "ResultDeserializationError";
		this.value = value;
	}
}

// ===========================================
// Ok Class
// ===========================================

export class Ok<T, E = never> {
	readonly status = "ok" as const;
	constructor(readonly value: T) {}

	isOk(): this is Ok<T, E> {
		return true;
	}
	isErr(): this is Err<T, E> {
		return false;
	}

	map<U>(fn: (value: T) => U): Ok<U, E> {
		return new Ok(tryOrPanic(fn, this.value, "Result.map callback threw"));
	}

	mapError<E2>(_fn: (error: E) => E2): Ok<T, E2> {
		// `E` is phantom on `Ok` (no error value is stored), so re-tagging the
		// error type is a value-preserving reconstruction, not a cast.
		return new Ok<T, E2>(this.value);
	}

	andThen<U, E2>(fn: (value: T) => Result<U, E2>): Result<U, E | E2> {
		return tryOrPanic(fn, this.value, "Result.andThen callback threw");
	}

	match<R>(handlers: { ok: (value: T) => R; err: (error: E) => R }): R {
		return tryOrPanic(handlers.ok, this.value, "Result.match ok handler threw");
	}

	unwrap(_message?: string): T {
		return this.value;
	}

	unwrapOr<U>(_fallback: U): T {
		return this.value;
	}

	tap(fn: (value: T) => void): Ok<T, E> {
		tryOrPanic(fn, this.value, "Result.tap callback threw");
		return this;
	}

	// Generator protocol: Ok yields nothing, returns value directly.
	// Implemented as a manual iterator (not a generator) to avoid
	// biome's useYield lint — Ok genuinely has nothing to yield.
	[Symbol.iterator](): Generator<Err<never, E>, T, undefined> {
		let done = false;
		const value = this.value;
		return {
			next(): IteratorResult<Err<never, E>, T> {
				if (!done) {
					done = true;
					return { done: true, value };
				}
				return { done: true, value };
			},
			return(v: T): IteratorResult<Err<never, E>, T> {
				return { done: true, value: v };
			},
			throw(e: unknown): IteratorResult<Err<never, E>, T> {
				throw e;
			},
			[Symbol.iterator]() {
				return this;
			},
		} as Generator<Err<never, E>, T, undefined>;
	}
}

// ===========================================
// Err Class
// ===========================================

export class Err<T = never, E = unknown> {
	readonly status = "error" as const;
	constructor(readonly error: E) {}

	isOk(): this is Ok<T, E> {
		return false;
	}
	isErr(): this is Err<T, E> {
		return true;
	}

	map<U>(_fn: (value: T) => U): Err<U, E> {
		// `T` is phantom on `Err` (no success value is stored), so re-tagging the
		// value type is a value-preserving reconstruction, not a cast.
		return new Err<U, E>(this.error);
	}

	mapError<E2>(fn: (error: E) => E2): Err<T, E2> {
		return new Err(tryOrPanic(fn, this.error, "Result.mapError callback threw"));
	}

	andThen<U, E2>(_fn: (value: T) => Result<U, E2>): Err<U, E | E2> {
		// `T` is phantom on `Err`; reconstruct with the widened error type.
		return new Err<U, E | E2>(this.error);
	}

	match<R>(handlers: { ok: (value: T) => R; err: (error: E) => R }): R {
		return tryOrPanic(handlers.err, this.error, "Result.match err handler threw");
	}

	unwrap(message?: string): never {
		throw new Panic(
			message ??
				`Called unwrap on Err: ${this.error instanceof Error ? this.error.message : String(this.error)}`,
			this.error,
		);
	}

	unwrapOr<U>(fallback: U): T | U {
		return fallback;
	}

	tap(_fn: (value: T) => void): Err<T, E> {
		return this;
	}

	// Generator protocol: Err yields itself, then panics if continued
	[Symbol.iterator](): Generator<Err<never, E>, never, undefined> {
		// `T` is phantom on `Err` (no success value is stored), so reusing `this`
		// under a narrowed `Err<never, E>` view is sound — it is NOT a fresh
		// allocation. That matters beyond allocation cost: a fresh `new Err(...)`
		// here would make `[Symbol.iterator]` produce a brand-new Err on every
		// call, and since that new Err is itself iterable, iterable-aware deep
		// equality (e.g. vitest/chai's `toEqual`) walking it would recurse into
		// an ever-growing chain of distinct Err instances instead of hitting a
		// cycle — Maximum call stack size exceeded. Yielding `this` back makes
		// the chain self-referential, which cycle-detecting deep-equal
		// implementations correctly short-circuit.
		// SAFETY: `Err<T, E>` stores only `error: E`; `T` is phantom, so no field
		// of `this` depends on it. Narrowing `T` to `never` therefore removes a
		// type parameter nothing reads — the runtime object is unchanged, and the
		// double cast is only needed because TS cannot see that `T` is unused.
		const self = this as unknown as Err<never, E>;
		return (function* (): Generator<Err<never, E>, never, undefined> {
			yield self;
			throw new Panic(
				"Generator continued after yielding Err — this is a defect in Result.gen",
			);
		})();
	}
}

// ===========================================
// Result Union Type
// ===========================================

export type Result<T, E> = Ok<T, E> | Err<T, E>;

// ===========================================
// Type Inference Helpers
// ===========================================

export type InferOk<R> = R extends Ok<infer T, unknown> ? T : never;
export type InferErr<R> = R extends Err<unknown, infer E> ? E : never;
type InferYieldErr<Y> = Y extends Err<never, infer E> ? E : never;
type AnyResult = Ok<unknown, unknown> | Err<unknown, unknown>;

// ===========================================
// Factory Functions
// ===========================================

export function ok(): Ok<void, never>;
export function ok<T, E = never>(value: T): Ok<T, E>;
export function ok<T>(value?: T): Ok<T | void, never> {
	return new Ok(value as T);
}

export function err<T = never, E = unknown>(error: E): Err<T, E> {
	return new Err<T, E>(error);
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T, E> {
	return result.status === "ok";
}

export function isErr<T, E>(result: Result<T, E>): result is Err<T, E> {
	return result.status === "error";
}

// ===========================================
// Serialization
// ===========================================

interface SerializedOk<T> {
	status: "ok";
	value: T;
}
interface SerializedErr<E> {
	status: "error";
	error: E;
}
export type SerializedResult<T, E> = SerializedOk<T> | SerializedErr<E>;

function isSerializedResult(obj: unknown): obj is SerializedResult<unknown, unknown> {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"status" in obj &&
		(obj.status === "ok" || obj.status === "error")
	);
}

export function serialize<T, E>(result: Result<T, E>): SerializedResult<T, E> {
	return result.status === "ok"
		? { status: "ok", value: result.value }
		: { status: "error", error: result.error };
}

export function deserialize<T, E>(value: unknown): Result<T, E | ResultDeserializationError> {
	if (isSerializedResult(value)) {
		// `isSerializedResult` narrows to `SerializedResult<unknown, unknown>`, so
		// the payloads are `unknown` at the deserialization boundary. Construct the
		// typed variant directly — `Ok`/`Err` are `Result` members, so only the
		// payloads (from `unknown`) carry an assertion.
		return value.status === "ok"
			? new Ok<T, E>(value.value as T)
			: new Err<T, E>(value.error as E);
	}
	return err(new ResultDeserializationError(value));
}

// ===========================================
// Try / TryPromise
// ===========================================

/** Wrap a synchronous function call in a Result */
export function tryFn<T>(thunk: () => T): Result<T, UnhandledException>;
export function tryFn<T, E>(opts: { try: () => T; catch: (cause: unknown) => E }): Result<T, E>;
export function tryFn<T, E>(
	thunkOrOpts: (() => T) | { try: () => T; catch: (cause: unknown) => E },
): Result<T, E | UnhandledException> {
	if (typeof thunkOrOpts === "function") {
		try {
			return ok(thunkOrOpts());
		} catch (cause) {
			return err(new UnhandledException(cause));
		}
	}
	try {
		return ok(thunkOrOpts.try());
	} catch (cause) {
		return err(thunkOrOpts.catch(cause));
	}
}

/** Wrap an async function call in a Result */
export async function tryPromise<T>(
	thunk: () => Promise<T>,
): Promise<Result<T, UnhandledException>>;
export async function tryPromise<T, E>(opts: {
	try: () => Promise<T>;
	catch: (cause: unknown) => E;
}): Promise<Result<T, E>>;
export async function tryPromise<T, E>(
	thunkOrOpts: (() => Promise<T>) | { try: () => Promise<T>; catch: (cause: unknown) => E },
): Promise<Result<T, E | UnhandledException>> {
	if (typeof thunkOrOpts === "function") {
		try {
			return ok(await thunkOrOpts());
		} catch (cause) {
			return err(new UnhandledException(cause));
		}
	}
	try {
		return ok(await thunkOrOpts.try());
	} catch (cause) {
		return err(thunkOrOpts.catch(cause));
	}
}

// ===========================================
// Generator Composition
// ===========================================

/**
 * Compose multiple Result-returning operations using generators.
 * Yield* a Result to unwrap it — if it's Err, short-circuits the generator.
 *
 * @example
 * ```ts
 * const result = gen(function*() {
 *   const a = yield* parseJson(input);
 *   const b = yield* validateSchema(a);
 *   return ok(b.data);
 * });
 * ```
 */
export function gen<Yield extends Err<never, unknown>, R extends AnyResult>(
	body: () => Generator<Yield, R, unknown>,
): Result<InferOk<R>, InferYieldErr<Yield> | InferErr<R>> {
	const iterator = body();
	const state = iterator.next();

	if (state.done) {
		return state.value as Result<InferOk<R>, InferErr<R>>;
	}

	// Generator yielded — must be an Err (short-circuit)
	const yielded = state.value;
	if (yielded.status === "error") {
		// We only call `.return()` to run the generator's `finally` cleanup; the
		// completion value is discarded, so a placeholder satisfies the `R`
		// parameter. Widen through `unknown` to avoid a type-system bypass.
		const placeholder: unknown = undefined;
		iterator.return?.(placeholder as R);
		return yielded as Err<never, InferYieldErr<Yield>>;
	}

	throw new Panic(
		"Generator yielded a non-Err value — this is a defect in the Result implementation",
	);
}

// ===========================================
// Collection Utilities
// ===========================================

/** Split an array of Results into [successes, failures] */
export function partition<T, E>(results: readonly Result<T, E>[]): [T[], E[]] {
	const oks: T[] = [];
	const errs: E[] = [];
	for (const r of results) {
		if (r.status === "ok") oks.push(r.value);
		else errs.push(r.error);
	}
	return [oks, errs];
}

/** Unwrap a nested Result */
export function flatten<T, E, E2>(result: Result<Result<T, E>, E2>): Result<T, E | E2> {
	if (result.status === "ok") return result.value;
	// On the error branch `result` is `Err<Result<T, E>, E2>`; the success type
	// is phantom, so reconstruct with the flattened value type.
	return new Err<T, E | E2>(result.error);
}

// ===========================================
// Panic Helpers
// ===========================================

export function isPanic(value: unknown): value is Panic {
	return value instanceof Panic;
}

export function panic(message: string, cause?: unknown): never {
	throw new Panic(message, cause);
}

// ===========================================
// Error Matching
// ===========================================

type MatchHandlers<E extends AnyTaggedError, R> = {
	[K in E["_tag"]]: (err: Extract<E, { _tag: K }>) => R;
};

/** Exhaustive pattern matching on tagged errors */
export function matchError<E extends AnyTaggedError, R>(
	error: E,
	handlers: MatchHandlers<E, R>,
): R {
	const handler = handlers[error._tag as E["_tag"]];
	return handler(error as Extract<E, { _tag: (typeof error)["_tag"] }>);
}

// ===========================================
// Internal Helpers
// ===========================================

function tryOrPanic<A, R>(fn: (a: A) => R, arg: A, message: string): R {
	try {
		return fn(arg);
	} catch (cause) {
		throw new Panic(message, cause);
	}
}

// ===========================================
// Namespace Export (mirrors better-result API)
// ===========================================

export const Result = {
	ok,
	err,
	isOk,
	isErr,
	try: tryFn,
	tryPromise,
	gen,
	partition,
	flatten,
	serialize,
	deserialize,
	matchError,
	isPanic,
	panic,
} as const;
