import { describe, expect, it, vi } from "vitest";

vi.mock("node:module", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:module")>();
    return {
        ...actual,
        createRequire: () => () => {
            throw new Error("Cannot find module 'typescript'");
        },
    };
});

import { countUnjustifiedCasts, findUnjustifiedCasts } from "./cast-justification.js";

describe("cast measurement without optional TypeScript", () => {
    it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("keeps lexical comment scope across separator %j", (separator) => {
        const content = ["const heading = 1;", "// SAFETY: the first shape was validated", "const a = input as User;", "const b = input as Admin;"].join(separator);
        expect(findUnjustifiedCasts(content, "source.ts")).toEqual([{ line: 4, text: "const b = input as Admin;" }]);
    });
    it("retains the existing lexical line measurement across repeated calls", () => {
        const content = "const a = input as unknown as User;\nconst b = input as Admin;";
        expect(countUnjustifiedCasts(content)).toBe(2);
        expect(countUnjustifiedCasts(content)).toBe(2);
        expect(findUnjustifiedCasts(content, "source.ts").map((match) => match.line)).toEqual([1, 2]);
    });

    it("requires nonempty explanations in actual comments on the fallback path", () => {
        const content = [
            "const a = input as User; // SAFETY: validated above",
            'const b = "SAFETY: trusted" as User;',
            "// SAFETY:",
            "const c = input as User;",
        ].join("\n");
        expect(findUnjustifiedCasts(content, "source.ts").map((match) => match.line)).toEqual([2, 4]);
    });
});
