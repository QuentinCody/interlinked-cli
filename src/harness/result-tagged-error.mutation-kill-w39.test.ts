import { describe, expect, it } from "vitest";
import { TaggedError } from "./result-tagged-error.js";

describe("result-tagged-error mutation kills (w39)", () => {
	// test-contract: public-api — rationale: TaggedError(tag)() must return a
	// constructible class whose instances are real Error subclasses.
	it("TaggedError factory returns a callable that yields a working class", () => {
		const factory = TaggedError("MyTag");
		expect(typeof factory).toBe("function");
		const Cls = factory<{ path: string }>();
		expect(typeof Cls).toBe("function");
		const e = new Cls({ path: "/x" });
		expect(e).toBeInstanceOf(Error);
		expect(e._tag).toBe("MyTag");
		expect(e.path).toBe("/x");
	});

	// test-contract: public-api — rationale: absent "message" key must fall back
	// to the tag string, not to args.message (which would be undefined).
	it("falls back to the tag as message when args has no message key", () => {
		const Cls = TaggedError("FallbackTag")();
		const e = new Cls({});
		expect(e.message).toBe("FallbackTag");
	});

	// test-contract: boundary — rationale: nullish args must short-circuit every
	// "in" check rather than being dereferenced; several mutants replace the
	// short-circuiting guard with a literal that dereferences args unconditionally.
	it("does not throw and falls back to tag when args is null", () => {
		const Cls = TaggedError("NullArgsTag")();
		let e: InstanceType<typeof Cls> | undefined;
		expect(() => {
			e = new Cls(null);
		}).not.toThrow();
		expect(e?.message).toBe("NullArgsTag");
		expect(Object.prototype.hasOwnProperty.call(e, "cause")).toBe(false);
	});

	// test-contract: public-api — rationale: a valid string message must be used
	// verbatim instead of the tag.
	it("uses a provided string message instead of the tag", () => {
		const Cls = TaggedError("IgnoredTag")<{ message: string }>();
		const e = new Cls({ message: "custom message" });
		expect(e.message).toBe("custom message");
	});

	// test-contract: invariant — rationale: when no cause is supplied, the
	// instance must not carry an own "cause" property at all (not even undefined).
	it("does not set an own cause property when no cause is supplied", () => {
		const Cls = TaggedError("NoCauseTag")();
		const e = new Cls({});
		expect(Object.prototype.hasOwnProperty.call(e, "cause")).toBe(false);
	});

	// test-contract: invariant — rationale: when a cause IS supplied, it must be
	// forwarded to Error's options.cause and readable back off the instance.
	it("forwards a supplied cause onto the instance", () => {
		const innerCause = new Error("root cause");
		const Cls = TaggedError("CauseTag")<{ cause: Error }>();
		const e = new Cls({ cause: innerCause });
		expect(Object.prototype.hasOwnProperty.call(e, "cause")).toBe(true);
		expect(e.cause).toBe(innerCause);
	});

	// test-contract: invariant — rationale: a supplied cause's stack must be
	// appended, indented, under a "Caused by:" section — not collapsed to a
	// single line.
	it("appends an indented Caused-by section when cause has a stack", () => {
		const innerCause = new Error("root cause");
		const Cls = TaggedError("StackTag")<{ cause: Error }>();
		const e = new Cls({ cause: innerCause });
		const idx = e.stack?.indexOf("Caused by:") ?? -1;
		expect(idx).toBeGreaterThan(-1);
		const tail = e.stack?.slice(idx) ?? "";
		expect(tail).toMatch(/\n/);
	});

	// test-contract: public-api — rationale: TaggedError.is must require actual
	// instanceof Error, not merely a "_tag" string property on any object.
	it("TaggedError.is rejects a plain object with a string _tag that is not an Error", () => {
		expect(TaggedError.is({ _tag: "foo" })).toBe(false);
	});

	// test-contract: boundary — rationale: TaggedError.is must require _tag to be
	// a string even on a real Error instance.
	it("TaggedError.is rejects an Error instance whose _tag is not a string", () => {
		const err = new Error("x");
		Object.assign(err, { _tag: 123 });
		expect(TaggedError.is(err)).toBe(false);
	});

	// test-contract: public-api — rationale: positive control for TaggedError.is.
	it("TaggedError.is accepts a real tagged error instance", () => {
		const Cls = TaggedError("RealTag")();
		const e = new Cls({});
		expect(TaggedError.is(e)).toBe(true);
	});
});
