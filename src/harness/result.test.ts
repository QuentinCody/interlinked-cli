// Coverage-focused tests for src/harness/result.ts — a hand-rolled Rust-style
// Result<T,E> with generator-protocol composition. No test file existed for
// this module before; these target the specific gaps measured from
// coverage/lcov.info rather than re-testing the whole surface.

import { describe, expect, it } from "vitest";
import { Err, Ok, Panic, Result, UnhandledException, err, gen, ok } from "./result.js";

describe("UnhandledException — cause-message branch", () => {
	it("uses cause.message when cause is an Error", () => {
		const exc = new UnhandledException(new Error("boom"));
		expect(exc.message).toBe("Unhandled exception: boom");
	});
	it("uses String(cause) when cause is not an Error", () => {
		const exc = new UnhandledException("plain string cause");
		expect(exc.message).toBe("Unhandled exception: plain string cause");
	});
});

describe("Ok generator protocol — manual iterator calls", () => {
	it("next() returns done:true,value on the first call and again on a second call", () => {
		const okResult = new Ok(5);
		const iter = okResult[Symbol.iterator]();
		expect(iter.next()).toEqual({ done: true, value: 5 });
		// Second call hits the `done` fallback branch — still done:true,value.
		expect(iter.next()).toEqual({ done: true, value: 5 });
	});
	it("return(v) yields done:true with the passed-in value", () => {
		const iter = new Ok(1)[Symbol.iterator]();
		expect(iter.return(99)).toEqual({ done: true, value: 99 });
	});
	it("throw(e) re-throws the given error", () => {
		const iter = new Ok(1)[Symbol.iterator]();
		expect(() => iter.throw(new Error("propagate me"))).toThrow("propagate me");
	});
	it("[Symbol.iterator]() on the iterator object returns itself", () => {
		const iter = new Ok(1)[Symbol.iterator]();
		expect(iter[Symbol.iterator]()).toBe(iter);
	});
});

describe("Err.unwrap — message and instanceof branches", () => {
	it("panics with the default message built from an Error's .message", () => {
		const e = new Err(new Error("boom"));
		expect(() => e.unwrap()).toThrow("Called unwrap on Err: boom");
	});
	it("panics with the default message built from String(error) for a non-Error", () => {
		const e = new Err("plain string error");
		expect(() => e.unwrap()).toThrow("Called unwrap on Err: plain string error");
	});
	it("panics with the caller-supplied message when provided", () => {
		const e = new Err("x");
		expect(() => e.unwrap("custom message")).toThrow("custom message");
	});
	it("the thrown value is a Panic instance carrying the original error as cause", () => {
		const original = new Error("boom");
		const e = new Err(original);
		try {
			e.unwrap();
			throw new Error("should have thrown");
		} catch (caught) {
			if (!(caught instanceof Panic)) throw caught;
			expect(caught.cause).toBe(original);
		}
	});
});

describe("Err generator protocol — continuation panic", () => {
	it("yields itself once, then panics if the generator is continued", () => {
		const errResult = new Err("oops");
		const iter = errResult[Symbol.iterator]();
		const first = iter.next();
		expect(first.done).toBe(false);
		expect(first.value).toBeInstanceOf(Err);
		expect(() => iter.next()).toThrow(
			"Generator continued after yielding Err — this is a defect in Result.gen",
		);
	});
});

describe("gen() — happy path and error short-circuit", () => {
	it("returns the ok value when the generator completes without yielding", () => {
		const result = gen(function* () {
			return ok(42);
		});
		expect(result).toEqual(ok(42));
	});

	it("short-circuits on yield* of an Err, propagating the error", () => {
		const result = gen(function* () {
			const value = yield* err<number, string>("bad");
			return ok(value * 2);
		});
		// Not `.toEqual(err("bad"))`: Err implements the iterator protocol (for
		// `yield*` delegation) and yields itself when iterated, so a fully
		// iterable-draining deep-equal would recurse into Err forever. Assert
		// shape via `toMatchObject` instead, which doesn't drain iterables.
		expect(result).toMatchObject({ status: "error", error: "bad" });
	});

});

describe("Result namespace export — exercises Result.gen/try wiring", () => {
	it("Result.gen matches the standalone gen()", () => {
		expect(Result.gen(function* () { return ok(7); })).toEqual(ok(7));
	});
});
