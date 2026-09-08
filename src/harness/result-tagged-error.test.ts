import { describe, expect, expectTypeOf, it } from "vitest";
import { TaggedError } from "./result-tagged-error.js";

describe("TaggedError property contract", () => {
	it("preserves named fields, string messages and causes in a subclass", () => {
		class FileError extends TaggedError("FileError")<{ path: string; message: string; cause: unknown }>() {}
		const cause = new Error("disk failed");
		const error = new FileError({ path: "/repo/a.ts", message: "read failed", cause });
		expect(error).toBeInstanceOf(FileError);
		expect(error.toJSON()).toMatchObject({ _tag: "FileError", name: "FileError", path: "/repo/a.ts", message: "read failed" });
		expect(error.cause).toBe(cause);
		expect(FileError.is(error)).toBe(true);
		expect(FileError.is({ _tag: "FileError", path: "/repo/a.ts" })).toBe(false);
	});

	it("rejects inherited fields instead of returning an instance missing them", () => {
		class InheritedArgs { get path(): string { return "/inherited"; } }
		const FileError = TaggedError("FileError")<{ path: string }>();
		expect(() => new FileError(new InheritedArgs())).toThrow("plain object");
	});

	it("rejects non-enumerable fields instead of dropping them", () => {
		const FileError = TaggedError("FileError")<{ path: string }>();
		const args = Object.defineProperty({ path: "/hidden" }, "path", { enumerable: false });
		expect(() => new FileError(args)).toThrow("path must be enumerable");
	});

	it.each(["_tag", "name", "stack", "toJSON", "toString", "constructor", "__proto__"])("rejects reserved %s supplied from JavaScript", (key) => {
		const ErrorClass = TaggedError("Protected")();
		expect(() => Reflect.construct(ErrorClass, [{ [key]: "replacement" }])).toThrow("is reserved");
	});

	it.each([42, undefined, null])("rejects a non-string message supplied from JavaScript: %s", (message) => {
		const ErrorClass = TaggedError("Protected")();
		expect(() => Reflect.construct(ErrorClass, [{ message }])).toThrow("message must be a string");
	});

	it("supports empty null arguments without promising an impossible string index", () => {
		const EmptyError = TaggedError("Empty")();
		const error = new EmptyError(null);
		expect(error.message).toBe("Empty");
		expect(error.toJSON()).toMatchObject({ _tag: "Empty", name: "Empty" });
		expectTypeOf(error).not.toExtend<Record<string, never>>();
	});

	it("permits only named properties compatible with Error", () => {
		const factory = TaggedError("Shape");
		expectTypeOf<Parameters<typeof factory<{ path: string; message?: string }>>>().toEqualTypeOf<[]>();
		expectTypeOf<Parameters<typeof factory<{ cause: undefined }>>>().toEqualTypeOf<[]>();
		expectTypeOf<Parameters<typeof factory<{ name: number }>>>().toEqualTypeOf<[never]>();
		expectTypeOf<Parameters<typeof factory<{ message: number }>>>().toEqualTypeOf<[never]>();
		expectTypeOf<Parameters<typeof factory<{ message?: string | undefined }>>>().toEqualTypeOf<[never]>();
		expectTypeOf<Parameters<typeof factory<Record<string, never>>>>().toEqualTypeOf<[never]>();
		expectTypeOf<Parameters<typeof factory<Record<number, string>>>>().toEqualTypeOf<[never]>();
		expectTypeOf<Parameters<typeof factory<Record<`field_${string}`, string>>>>().toEqualTypeOf<[never]>();
		expectTypeOf<Parameters<typeof factory<{ path: string } | Record<string, never>>>>().toEqualTypeOf<[never]>();
	});
});
