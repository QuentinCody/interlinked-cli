import { expect, it } from "vitest";
import { residentPolicy, validateVectors } from "./runtime.js";

it("never loads a second model over an unrelated resident", () => {
    expect(
        residentPolicy(["clef-flash:9b"], "qwen3-embedding:4b", [
            "clef-flash:9b",
            "qwen3-embedding:4b",
        ]),
    ).toEqual(["clef-flash:9b"]);
    expect(() => residentPolicy(["user-model"], "clef-flash:9b", ["clef-flash:9b"])).toThrow(
        /unrelated/,
    );
    expect(residentPolicy([], "clef-flash:9b", [])).toEqual([]);
});

it("refuses missing, truncated, inconsistent and zero embedding vectors", () => {
    expect(
        validateVectors(
            [
                [1, 0],
                [0, 1],
            ],
            2,
        ),
    ).toEqual([
        [1, 0],
        [0, 1],
    ]);
    expect(() => validateVectors([[1, 0]], 2)).toThrow();
    expect(() => validateVectors([[0, 0]], 1)).toThrow();
    expect(() => validateVectors([[1, 0], [1]], 2)).toThrow();
});
