import { describe, expect, it } from "vitest";
import { firstArgumentText, isNonFormatLoggerArgument } from "./js-security-checks-logger-arg.js";

describe("firstArgumentText", () => {
	it("stops at the depth-0 comma or closing paren", () => {
		expect(firstArgumentText('a.b(c, d), ""', 0)).toBe("a.b(c, d)");
		expect(firstArgumentText("user ? `${x}` : ``);", 0)).toBe("user ? `${x}` : ``");
		expect(firstArgumentText("req.body", 0)).toBe("req.body");
	});
});

describe("isNonFormatLoggerArgument — positive (argument is not a format string)", () => {
	it("P1: a ternary whose branches are both string or template literals", () => {
		expect(isNonFormatLoggerArgument('user ? "" : ""')).toBe(true);
		expect(isNonFormatLoggerArgument("input === undefined ? `` : ``")).toBe(true);
		expect(isNonFormatLoggerArgument("user ? '' : ok ? \"\" : ``")).toBe(true);
	});

	it("P2: a comparison whose result is a boolean", () => {
		expect(isNonFormatLoggerArgument("query === null")).toBe(true);
		expect(isNonFormatLoggerArgument("user instanceof Admin")).toBe(true);
		expect(isNonFormatLoggerArgument("input.size > limit")).toBe(true);
	});
});

describe("isNonFormatLoggerArgument — negative (argument may be a format string)", () => {
	it("N1: a bare or chained source value", () => {
		expect(isNonFormatLoggerArgument("req")).toBe(false);
		expect(isNonFormatLoggerArgument("req.body.message")).toBe(false);
		expect(isNonFormatLoggerArgument('user?.name ?? ""')).toBe(false);
	});

	it("N2: a ternary with a non-literal branch", () => {
		expect(isNonFormatLoggerArgument('user ? user.name : ""')).toBe(false);
		expect(isNonFormatLoggerArgument('user ? "" : input')).toBe(false);
	});

	it("N3: a comparison that short-circuits to a value, or one nested in a call or arrow", () => {
		expect(isNonFormatLoggerArgument("user !== null && user.name")).toBe(false);
		expect(isNonFormatLoggerArgument("user.find((u) => u.id === id)")).toBe(false);
		expect(isNonFormatLoggerArgument("input => input")).toBe(false);
	});
});
