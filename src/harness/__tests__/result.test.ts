import { describe, expect, it } from "vitest";
import {
	CheckError,
	ConfigLoadError,
	EventParseError,
	FileReadError,
	FileWriteError,
	JsonParseError,
	SubprocessError,
} from "../check-errors.js";
import {
	deserialize,
	err,
	flatten,
	gen,
	isErr,
	isOk,
	isPanic,
	matchError,
	ok,
	Panic,
	panic,
	partition,
	Result,
	ResultDeserializationError,
	serialize,
	TaggedError,
	tryFn,
	tryPromise,
	UnhandledException,
} from "../result.js";

// ===========================================
// Ok / Err Basics
// ===========================================

describe("Ok", () => {
	it("creates with value", () => {
		const r = ok(42);
		expect(r.status).toBe("ok");
		expect(r.value).toBe(42);
	});

	it("creates void ok", () => {
		const r = ok();
		expect(r.status).toBe("ok");
		expect(r.value).toBeUndefined();
	});

	it("isOk returns true", () => {
		expect(ok(1).isOk()).toBe(true);
		expect(ok(1).isErr()).toBe(false);
	});

	it("type guard isOk works", () => {
		const r: Result<number, string> = ok(42);
		expect(isOk(r)).toBe(true);
		expect(isErr(r)).toBe(false);
	});
});

describe("Err", () => {
	it("creates with error", () => {
		const r = err("fail");
		expect(r.status).toBe("error");
		expect(r.error).toBe("fail");
	});

	it("isErr returns true", () => {
		expect(err("x").isErr()).toBe(true);
		expect(err("x").isOk()).toBe(false);
	});

	it("type guard isErr works", () => {
		const r: Result<number, string> = err("fail");
		expect(isErr(r)).toBe(true);
		expect(isOk(r)).toBe(false);
	});
});

// ===========================================
// map / mapError
// ===========================================

describe("map", () => {
	it("transforms Ok value", () => {
		const r = ok(2).map((n) => n * 3);
		expect(r.value).toBe(6);
	});

	it("is no-op on Err", () => {
		const r = err<number, string>("fail").map((n) => n * 3);
		expect(r.error).toBe("fail");
	});

	it("throws Panic if callback throws", () => {
		expect(() =>
			ok(1).map(() => {
				throw new Error("boom");
			}),
		).toThrow(Panic);
	});
});

describe("mapError", () => {
	it("transforms Err error", () => {
		const r = err<number, string>("fail").mapError((e) => `wrapped: ${e}`);
		expect(r.error).toBe("wrapped: fail");
	});

	it("is no-op on Ok", () => {
		const r = ok<number, string>(42).mapError((e) => `wrapped: ${e}`);
		expect(r.value).toBe(42);
	});
});

// ===========================================
// andThen (flatMap)
// ===========================================

describe("andThen", () => {
	it("chains Ok to Ok", () => {
		const r = ok(2).andThen((n) => ok(n * 3));
		expect(isOk(r) && r.value).toBe(6);
	});

	it("chains Ok to Err", () => {
		const r = ok(2).andThen(() => err("fail"));
		expect(isErr(r) && r.error).toBe("fail");
	});

	it("short-circuits on Err", () => {
		let called = false;
		const r = err<number, string>("fail").andThen(() => {
			called = true;
			return ok(1);
		});
		expect(called).toBe(false);
		expect(isErr(r) && r.error).toBe("fail");
	});
});

// ===========================================
// match
// ===========================================

describe("match", () => {
	it("calls ok handler for Ok", () => {
		const result = ok(42).match({
			ok: (v) => `got ${v}`,
			err: () => "fail",
		});
		expect(result).toBe("got 42");
	});

	it("calls err handler for Err", () => {
		const result = err("bad").match({
			ok: () => "ok",
			err: (e) => `error: ${e}`,
		});
		expect(result).toBe("error: bad");
	});
});

// ===========================================
// unwrap / unwrapOr
// ===========================================

describe("unwrap", () => {
	it("returns value for Ok", () => {
		expect(ok(42).unwrap()).toBe(42);
	});

	it("throws Panic for Err", () => {
		expect(() => err("fail").unwrap()).toThrow(Panic);
	});

	it("throws Panic with custom message", () => {
		expect(() => err("fail").unwrap("custom msg")).toThrow("custom msg");
	});
});

describe("unwrapOr", () => {
	it("returns value for Ok", () => {
		expect(ok(42).unwrapOr(0)).toBe(42);
	});

	it("returns fallback for Err", () => {
		expect(err("fail").unwrapOr(0)).toBe(0);
	});
});

// ===========================================
// tap
// ===========================================

describe("tap", () => {
	it("runs side effect for Ok", () => {
		let sideEffect = 0;
		const r = ok(42).tap((v) => {
			sideEffect = v;
		});
		expect(sideEffect).toBe(42);
		expect(r.value).toBe(42);
	});

	it("skips side effect for Err", () => {
		let called = false;
		err("fail").tap(() => {
			called = true;
		});
		expect(called).toBe(false);
	});
});

// ===========================================
// tryFn
// ===========================================

describe("tryFn", () => {
	it("wraps successful sync call", () => {
		const r = tryFn(() => 42);
		expect(isOk(r) && r.value).toBe(42);
	});

	it("wraps thrown error as UnhandledException", () => {
		const r = tryFn(() => {
			throw new Error("boom");
		});
		expect(isErr(r)).toBe(true);
		if (isErr(r)) {
			expect(r.error).toBeInstanceOf(UnhandledException);
			expect(r.error.message).toContain("boom");
		}
	});

	it("supports typed catch", () => {
		const r = tryFn({
			try: () => JSON.parse("invalid"),
			catch: (cause) =>
				new JsonParseError({ message: "parse failed", input: "invalid", cause }),
		});
		expect(isErr(r)).toBe(true);
		if (isErr(r)) {
			expect(r.error._tag).toBe("JsonParseError");
		}
	});
});

// ===========================================
// tryPromise
// ===========================================

describe("tryPromise", () => {
	it("wraps successful async call", async () => {
		const r = await tryPromise(() => Promise.resolve(42));
		expect(isOk(r) && r.value).toBe(42);
	});

	it("wraps rejected promise", async () => {
		const r = await tryPromise(() => Promise.reject(new Error("async boom")));
		expect(isErr(r)).toBe(true);
		if (isErr(r)) {
			expect(r.error).toBeInstanceOf(UnhandledException);
		}
	});

	it("supports typed catch", async () => {
		const r = await tryPromise({
			try: () => Promise.reject(new Error("net fail")),
			catch: (cause) => new ConfigLoadError({ message: "load failed", path: "/foo", cause }),
		});
		expect(isErr(r)).toBe(true);
		if (isErr(r)) {
			expect(r.error._tag).toBe("ConfigLoadError");
		}
	});
});

// ===========================================
// Generator Composition
// ===========================================

describe("gen", () => {
	it("chains multiple Ok results", () => {
		const r = gen(function* () {
			const a = yield* ok(1);
			const b = yield* ok(2);
			return ok(a + b);
		});
		expect(isOk(r) && r.value).toBe(3);
	});

	it("short-circuits on first Err", () => {
		let reached = false;
		const r = gen(function* () {
			const a = yield* ok(1);
			yield* err<number, string>("fail");
			reached = true;
			return ok(a);
		});
		expect(reached).toBe(false);
		expect(isErr(r) && r.error).toBe("fail");
	});

	it("works with tryFn inside", () => {
		const r = gen(function* () {
			const parsed = yield* tryFn({
				try: () => ({ x: 1 }),
				catch: (cause) => new JsonParseError({ message: "bad json", input: "", cause }),
			});
			return ok(parsed.x);
		});
		expect(isOk(r) && r.value).toBe(1);
	});

	it("propagates typed error from tryFn", () => {
		const r = gen(function* () {
			const parsed = yield* tryFn({
				try: (): unknown => JSON.parse("not json"),
				catch: (cause) =>
					new JsonParseError({ message: "bad json", input: "not json", cause }),
			});
			return ok(parsed);
		});
		expect(isErr(r)).toBe(true);
		if (isErr(r)) {
			expect(r.error._tag).toBe("JsonParseError");
		}
	});
});

// ===========================================
// partition / flatten
// ===========================================

describe("partition", () => {
	it("splits Results into oks and errs", () => {
		const results: Result<number, string>[] = [ok(1), err("a"), ok(2), err("b")];
		const [oks, errs] = partition(results);
		expect(oks).toEqual([1, 2]);
		expect(errs).toEqual(["a", "b"]);
	});

	it("handles all Oks", () => {
		const [oks, errs] = partition([ok(1), ok(2)]);
		expect(oks).toEqual([1, 2]);
		expect(errs).toEqual([]);
	});

	it("handles all Errs", () => {
		const [oks, errs] = partition([err("a"), err("b")]);
		expect(oks).toEqual([]);
		expect(errs).toEqual(["a", "b"]);
	});

	it("handles empty array", () => {
		const [oks, errs] = partition([]);
		expect(oks).toEqual([]);
		expect(errs).toEqual([]);
	});
});

describe("flatten", () => {
	it("unwraps nested Ok", () => {
		const nested = ok(ok(42));
		const flat = flatten(nested);
		expect(isOk(flat) && flat.value).toBe(42);
	});

	it("unwraps nested Err (inner)", () => {
		const nested = ok(err("inner"));
		const flat = flatten(nested);
		expect(isErr(flat) && flat.error).toBe("inner");
	});

	it("preserves outer Err", () => {
		const nested = err<Result<number, string>, string>("outer");
		const flat = flatten(nested);
		expect(isErr(flat) && flat.error).toBe("outer");
	});
});

// ===========================================
// Serialization
// ===========================================

describe("serialize / deserialize", () => {
	it("round-trips Ok", () => {
		const original = ok(42);
		const serialized = serialize(original);
		expect(serialized).toEqual({ status: "ok", value: 42 });
		const restored = deserialize<number, string>(serialized);
		expect(isOk(restored) && restored.value).toBe(42);
	});

	it("round-trips Err", () => {
		const original = err("fail");
		const serialized = serialize(original);
		expect(serialized).toEqual({ status: "error", error: "fail" });
		const restored = deserialize<number, string>(serialized);
		expect(isErr(restored) && restored.error).toBe("fail");
	});

	it("returns ResultDeserializationError for invalid input", () => {
		const restored = deserialize({ invalid: true });
		expect(isErr(restored)).toBe(true);
		if (isErr(restored)) {
			expect(restored.error).toBeInstanceOf(ResultDeserializationError);
		}
	});

	it("returns ResultDeserializationError for null", () => {
		const restored = deserialize(null);
		expect(isErr(restored)).toBe(true);
	});

	it.each([{ status: "ok" }, { status: "error" }])("rejects an envelope without its payload: %j", (input) => {
		const restored = deserialize(input);
		expect(restored.status).toBe("error");
		expect(isErr(restored) && restored.error).toBeInstanceOf(ResultDeserializationError);
	});

	it("preserves an explicitly undefined success payload", () => {
		const restored = deserialize({ status: "ok", value: undefined });
		expect(restored.status).toBe("ok");
		expect(isOk(restored) && restored.value).toBeUndefined();
	});
});

// ===========================================
// TaggedError
// ===========================================

describe("TaggedError", () => {
	class TestError extends TaggedError("TestError")<{
		message: string;
		code: number;
	}>() {}

	it("creates instance with _tag", () => {
		const e = new TestError({ message: "test", code: 404 });
		expect(e._tag).toBe("TestError");
		expect(e.code).toBe(404);
		expect(e.message).toBe("test");
		expect(e.name).toBe("TestError");
	});

	it("is instanceof Error", () => {
		const e = new TestError({ message: "test", code: 500 });
		expect(e).toBeInstanceOf(Error);
	});

	it("static is() type guard works", () => {
		const e = new TestError({ message: "test", code: 500 });
		expect(TestError.is(e)).toBe(true);
		expect(TestError.is(new Error("other"))).toBe(false);
		expect(TestError.is(null)).toBe(false);
	});

	it("TaggedError.is() detects any tagged error", () => {
		const e = new TestError({ message: "test", code: 500 });
		expect(TaggedError.is(e)).toBe(true);
		expect(TaggedError.is(new Error("plain"))).toBe(false);
	});

	it("toJSON includes all properties", () => {
		const e = new TestError({ message: "test", code: 404 });
		const json = e.toJSON();
		expect(json._tag).toBe("TestError");
		expect(json.code).toBe(404);
		expect(json.message).toBe("test");
	});

	it("includes cause in stack trace", () => {
		const cause = new Error("root cause");
		class CausedError extends TaggedError("CausedError")<{
			message: string;
			cause: unknown;
		}>() {}
		const e = new CausedError({ message: "wrapper", cause });
		expect(e.stack).toContain("Caused by:");
	});
});

// ===========================================
// matchError
// ===========================================

describe("matchError", () => {
	it("dispatches to correct handler by _tag", () => {
		const e = new FileReadError({ message: "ENOENT", path: "/x", cause: null });
		// matchError uses _tag to dispatch — test with a single-type error
		const result = matchError(e, {
			FileReadError: (f) => `read: ${f.path}`,
		});
		expect(result).toBe("read: /x");
	});

	it("dispatches tagged errors by tag string", () => {
		const e = new SubprocessError({
			message: "fail",
			command: "tsc",
			exitCode: 1,
			stderr: "err",
		});
		const result = matchError(e, {
			SubprocessError: (s) => `exit: ${s.exitCode}`,
		});
		expect(result).toBe("exit: 1");
	});
});

// ===========================================
// Panic / isPanic
// ===========================================

describe("Panic", () => {
	it("is an Error", () => {
		const p = new Panic("defect");
		expect(p).toBeInstanceOf(Error);
		expect(p._tag).toBe("Panic");
	});

	it("isPanic detects Panic", () => {
		expect(isPanic(new Panic("x"))).toBe(true);
		expect(isPanic(new Error("x"))).toBe(false);
	});

	it("panic() throws", () => {
		expect(() => panic("crash")).toThrow(Panic);
	});
});

// ===========================================
// Check Error Types (check-errors.ts)
// ===========================================

describe("check-errors", () => {
	it("FileReadError has correct tag and properties", () => {
		const e = new FileReadError({ message: "ENOENT", path: "/foo.ts", cause: null });
		expect(e._tag).toBe("FileReadError");
		expect(e.path).toBe("/foo.ts");
		expect(FileReadError.is(e)).toBe(true);
	});

	it("FileWriteError has correct tag", () => {
		const e = new FileWriteError({ message: "EACCES", path: "/bar.ts", cause: null });
		expect(e._tag).toBe("FileWriteError");
	});

	it("JsonParseError preserves input", () => {
		const e = new JsonParseError({ message: "Unexpected token", input: "{bad", cause: null });
		expect(e._tag).toBe("JsonParseError");
		expect(e.input).toBe("{bad");
	});

	it("EventParseError preserves raw", () => {
		const e = new EventParseError({ message: "Invalid JSON", raw: "not-json", cause: null });
		expect(e._tag).toBe("EventParseError");
		expect(e.raw).toBe("not-json");
	});

	it("CheckError preserves check and file", () => {
		const e = new CheckError({
			message: "tsc crashed",
			check: "typescript",
			file: "foo.ts",
			cause: null,
		});
		expect(e._tag).toBe("CheckError");
		expect(e.check).toBe("typescript");
	});

	it("SubprocessError preserves command and exit code", () => {
		const e = new SubprocessError({
			message: "tsc failed",
			command: "tsc --noEmit",
			exitCode: 1,
			stderr: "error TS2345",
		});
		expect(e._tag).toBe("SubprocessError");
		expect(e.exitCode).toBe(1);
		expect(e.stderr).toContain("TS2345");
	});

	it("ConfigLoadError has correct tag", () => {
		const e = new ConfigLoadError({
			message: "missing",
			path: ".interlinked/config.json",
			cause: null,
		});
		expect(e._tag).toBe("ConfigLoadError");
	});

	it("all errors pass TaggedError.is()", () => {
		expect(TaggedError.is(new FileReadError({ message: "x", path: "x", cause: null }))).toBe(
			true,
		);
		expect(
			TaggedError.is(
				new SubprocessError({ message: "x", command: "x", exitCode: 1, stderr: "" }),
			),
		).toBe(true);
	});

	it("errors work with matchError", () => {
		const e = new FileReadError({ message: "ENOENT", path: "/x", cause: null });
		const msg = matchError(e, {
			FileReadError: (f) => `read: ${f.path}`,
		});
		expect(msg).toBe("read: /x");
	});

	it("errors work in Result pipeline", () => {
		const r = tryFn({
			try: () => JSON.parse("invalid"),
			catch: (cause) => new JsonParseError({ message: "bad", input: "invalid", cause }),
		});
		expect(isErr(r)).toBe(true);
		if (isErr(r)) {
			expect(r.error._tag).toBe("JsonParseError");
			expect(r.error.input).toBe("invalid");
		}
	});
});

// ===========================================
// Result Namespace (mirrors better-result API)
// ===========================================

describe("Result namespace", () => {
	it("exposes all methods", () => {
		expect(Result.ok).toBe(ok);
		expect(Result.err).toBe(err);
		expect(Result.isOk).toBe(isOk);
		expect(Result.isErr).toBe(isErr);
		expect(Result.try).toBe(tryFn);
		expect(Result.tryPromise).toBe(tryPromise);
		expect(Result.gen).toBe(gen);
		expect(Result.partition).toBe(partition);
		expect(Result.flatten).toBe(flatten);
		expect(Result.serialize).toBe(serialize);
		expect(Result.deserialize).toBe(deserialize);
		expect(Result.matchError).toBe(matchError);
		expect(Result.isPanic).toBe(isPanic);
		expect(Result.panic).toBe(panic);
	});
});
