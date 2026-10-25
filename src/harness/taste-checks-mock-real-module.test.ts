import { describe, expect, it } from "vitest";
import { keepsRealModule, sameDirSiblingBase } from "./taste-checks-mock-real-module.js";

/** Run `keepsRealModule` on a mock call whose path literal is `"./foo"` on line 0. */
function keeps(source: string, sut = "foo"): boolean {
	const lines = source.split("\n");
	const first = lines[0] ?? "";
	const afterPath = first.indexOf('"./foo"') + '"./foo"'.length;
	return keepsRealModule(lines, 0, afterPath, sut);
}

describe("keepsRealModule — positive (keeps the real module)", () => {
	it("P1: vitest `{ spy: true }` option", () => {
		expect(keeps('vi.mock("./foo", { spy: true });')).toBe(true);
		expect(keeps(['vi.mock("./foo", {', "\tspy: true,", "});"].join("\n"))).toBe(true);
	});

	it("P2: a factory returning jest.requireActual of the same module", () => {
		expect(keeps('jest.mock("./foo", () => jest.requireActual("./foo"));')).toBe(true);
		expect(keeps('jest.mock("./foo", () => jest.requireActual("./foo.js"));')).toBe(true);
	});

	it("P3: a factory returning importOriginal() or vi.importActual wholesale", () => {
		expect(keeps('vi.mock("./foo", async (importOriginal) => await importOriginal());')).toBe(true);
		expect(keeps('vi.mock("./foo", async (orig) => orig<typeof import("./foo")>());')).toBe(true);
		expect(keeps('vi.mock("./foo", () => vi.importActual("./foo"));')).toBe(true);
	});

	it("P4: the __esModule interop spread with no overrides, across lines", () => {
		const src = ['jest.mock("./foo", () => ({', "\t__esModule: true,", '\t...jest.requireActual("./foo"),', "}));"].join(
			"\n",
		);
		expect(keeps(src)).toBe(true);
		expect(keeps('vi.mock("./foo", async (importOriginal) => ({ ...(await importOriginal()) }));')).toBe(true);
	});
});

describe("keepsRealModule — negative (a replacement)", () => {
	it("N1: no options, `{ spy: false }`, or a factory returning a spy object", () => {
		expect(keeps('vi.mock("./foo");')).toBe(false);
		expect(keeps('vi.mock("./foo", { spy: false });')).toBe(false);
		expect(keeps('vi.mock("./foo", () => ({ spy: true }));')).toBe(false);
	});

	it("N2: a partial mock that overrides an export", () => {
		expect(keeps('vi.mock("./foo", async (importOriginal) => ({ ...(await importOriginal()), run: vi.fn() }));')).toBe(
			false,
		);
		expect(keeps('jest.mock("./foo", () => ({ ...jest.requireActual("./foo"), run: jest.fn() }));')).toBe(false);
	});

	it("N3: a factory returning the actual of a DIFFERENT module", () => {
		expect(keeps('jest.mock("./foo", () => jest.requireActual("./bar"));')).toBe(false);
		expect(keeps('jest.mock("./foo", () => jest.requireActual("../lib/foo"));')).toBe(false);
	});

	it("N4: an importOriginal call on a name the factory did not declare", () => {
		expect(keeps('vi.mock("./foo", async () => importOriginal());')).toBe(false);
	});
});

describe("sameDirSiblingBase", () => {
	it("P1: strips `./` and a code extension of a same-directory path", () => {
		expect(sameDirSiblingBase("./foo.js")).toBe("foo");
		expect(sameDirSiblingBase("foo")).toBe("foo");
	});

	it("N1: a sub-directory or parent path has no sibling base", () => {
		expect(sameDirSiblingBase("../foo")).toBe("");
		expect(sameDirSiblingBase("./foo/foo")).toBe("");
	});
});
