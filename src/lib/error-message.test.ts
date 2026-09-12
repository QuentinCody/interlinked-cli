import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message.js";

describe("errorMessage", () => {
    it.each([
        [new Error("compiler failed"), "compiler failed"],
        [{ message: "remote failure", code: 500 }, "remote failure"],
        ["connection closed", "connection closed"],
        [null, "null"],
        [undefined, "undefined"],
        [{ message: 42 }, "[object Object]"],
        [[], ""],
    ])("renders thrown values without losing their available message: %j", (value, expected) => {
        expect(errorMessage(value)).toBe(expected);
    });
});
