import { describe, expect, it } from "vitest";
import { DEFAULT_COWORK_POLICY, parseCoworkPolicy } from "./policy.js";

describe("Cowork policy boundaries", () => {
    it("normalizes absolute targets and refuses ineffective relative targets", () => {
        expect(parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, deniedPaths: ["/native/sub/../protected.txt"] }).deniedPaths).toEqual(["/native/protected.txt"]);
        expect(() => parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, deniedPaths: ["protected.txt"] })).toThrow("absolute");
    });
    it.each(["http://example.com/hook", "https://user:password@example.com/hook", "https://example.com/hook?token=example", "file:///tmp/hook"])("rejects unsafe bridge transport %s", url => {
        expect(() => parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, bridge: { url, tokenEnv: "COWORK_TOKEN", workspace: "project" } })).toThrow();
    });
    it("rejects misspelled top-level settings rather than ignoring them", () => {
        expect(() => parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, deniedTool: ["Write"] })).toThrow("Unknown");
    });
});
