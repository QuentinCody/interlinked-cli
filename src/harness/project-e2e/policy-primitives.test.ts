// The policy parser's constructing primitives (extracted from policy.ts by the
// line cap): every refusal names the field, every accepted value is exact.
import { describe, expect, it } from "vitest";
import { argvStep, checkPlaceholders, globList, id, oneOf, onlyKeys, record, relativePath, stringList, unique } from "./policy-primitives.js";

describe("policy primitives — positive (must accept)", () => {
    it("P1: exact values pass through unchanged; a Windows-separated path is normalized; an argv step keeps its tokens", () => {
        expect(record({ a: 1 }, "x")).toEqual({ a: 1 });
        expect(id("orders.create-1", "x")).toBe("orders.create-1");
        expect(stringList(["a", "b"], "x")).toEqual(["a", "b"]);
        expect(relativePath("src\\cli.ts", "x")).toBe("src/cli.ts");
        expect(globList(["src/**"], "x")).toEqual(["src/**"]);
        expect(oneOf("json", ["json", "junit"] as const, "x")).toBe("json");
        expect(argvStep({ argv: ["node", "build.mjs", "{run-directory}"] }, "x")).toEqual({ argv: ["node", "build.mjs", "{run-directory}"] });
        expect(() => unique(["a", "b"], "x")).not.toThrow();
        expect(() => onlyKeys({ argv: [] }, ["argv"], "x")).not.toThrow();
        expect(() => checkPlaceholders("{port}", "x", ["{port}"])).not.toThrow();
    });
});
describe("policy primitives — negative (must refuse, naming the field)", () => {
    it("N1: non-objects, bad ids, empty strings, absolute or escaping paths, unknown members, duplicates, unknown keys and unknown placeholders", () => {
        expect(() => record([], "x")).toThrow(/x must be an object/);
        expect(() => id("bad id!", "x")).toThrow(/x needs an id matching/);
        expect(() => stringList(["a", ""], "x")).toThrow(/x must be a list of at most 256 non-empty strings/);
        expect(() => relativePath("/etc/passwd", "x")).toThrow(/confined project-relative path/);
        expect(() => relativePath("../up", "x")).toThrow(/confined project-relative path/);
        expect(() => oneOf("yaml", ["json", "junit"] as const, "x")).toThrow(/x must be one of json, junit/);
        expect(() => unique(["a", "a"], "x")).toThrow(/x ids must be unique/);
        expect(() => onlyKeys({ nope: 1 }, ["argv"], "x")).toThrow(/x has unknown key "nope"/);
        expect(() => argvStep({ argv: [] }, "x")).toThrow(/x\.argv must not be empty/);
        expect(() => argvStep({ argv: ["node", "{port}"] }, "x")).toThrow(/unknown placeholder \{port\}/);
        expect(() => checkPlaceholders("{oops", "x")).toThrow(/unknown placeholder \{oops/);
    });
});
