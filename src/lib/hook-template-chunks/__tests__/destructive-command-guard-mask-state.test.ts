// Companion test for the mask-state helpers extracted from
// destructive-command-guard.ts during the line-cap split. These functions
// blank out quoted/escaped/commented shell spans so a destructive verb that
// only appears as quoted DATA isn't mistaken for an executable verb, and
// detect the shutdown/reboot family on the masked text.

import { describe, expect, it } from "vitest";
import {
	dcgMaskCommentStep,
	dcgMaskInlineQuotedShell,
	dcgMaskQuoteStep,
	dcgMaskUnquotedStep,
	dcgMatchesShutdown,
} from "../destructive-command-guard-mask-state.js";

describe("dcgMaskInlineQuotedShell — quoting/comment masking", () => {
	it("blanks a single-quoted span", () => {
		expect(dcgMaskInlineQuotedShell("echo 'reboot'")).toBe("echo         ");
	});

	it("blanks a double-quoted span", () => {
		expect(dcgMaskInlineQuotedShell('echo "reboot"')).toBe("echo         ");
	});

	it("blanks a backtick-quoted span", () => {
		const backtick = String.fromCharCode(96);
		expect(dcgMaskInlineQuotedShell(`echo ${backtick}reboot${backtick}`)).toBe("echo         ");
	});

	it("blanks a shell comment through end-of-line and resumes after", () => {
		const masked = dcgMaskInlineQuotedShell("echo hi # reboot now\nls");
		expect(masked).toBe("echo hi             \nls");
	});

	it("does not treat a mid-token '#' as a comment start", () => {
		// only a '#' at index 0 or preceded by whitespace starts a comment
		expect(dcgMaskInlineQuotedShell("echo foo#bar")).toBe("echo foo#bar");
	});

	it("leaves unquoted, uncommented text untouched", () => {
		expect(dcgMaskInlineQuotedShell("sudo reboot")).toBe("sudo reboot");
	});

	it("handles an escaped quote character inside a quoted span", () => {
		// the backslash-escaped quote must not end the span early
		expect(dcgMaskInlineQuotedShell("echo 'it\\'s'")).toBe("echo        ");
	});
});

describe("dcgMaskCommentStep / dcgMaskQuoteStep / dcgMaskUnquotedStep — unit steps", () => {
	it("dcgMaskCommentStep ends the comment on newline and blanks everything else", () => {
		const state = { quote: null, escaped: false, comment: true };
		expect(dcgMaskCommentStep("x", state)).toBe(" ");
		expect(state.comment).toBe(true);
		expect(dcgMaskCommentStep("\n", state)).toBe("\n");
		expect(state.comment).toBe(false);
	});

	it("dcgMaskQuoteStep closes the quote on the matching character", () => {
		const state = { quote: "'", escaped: false, comment: false };
		expect(dcgMaskQuoteStep("a", state)).toBe(" ");
		expect(state.quote).toBe("'");
		expect(dcgMaskQuoteStep("'", state)).toBe(" ");
		expect(state.quote).toBe(null);
	});

	it("dcgMaskUnquotedStep opens a quote span on a quote char", () => {
		const state = { quote: null, escaped: false, comment: false };
		expect(dcgMaskUnquotedStep('"', 0, '"x"', state)).toBe(" ");
		expect(state.quote).toBe('"');
	});

	it("dcgMaskUnquotedStep passes through an ordinary character", () => {
		const state = { quote: null, escaped: false, comment: false };
		expect(dcgMaskUnquotedStep("x", 0, "x", state)).toBe("x");
	});
});

describe("dcgMatchesShutdown — positive (must fire)", () => {
	it("P1: matches a direct shutdown command", () => {
		expect(dcgMatchesShutdown("shutdown -h now")).toBe(true);
	});

	it("P2: matches sudo-wrapped reboot", () => {
		expect(dcgMatchesShutdown("sudo reboot")).toBe(true);
	});

	it("P3: matches reboot inside a quoted bash -c string", () => {
		expect(dcgMatchesShutdown('bash -c "reboot"')).toBe(true);
	});
});

describe("dcgMatchesShutdown — negative (must not fire)", () => {
	it("N1: does not match reboot appearing only as quoted data", () => {
		expect(dcgMatchesShutdown("echo 'do not reboot'")).toBe(false);
	});

	it("N2: does not match an unrelated command", () => {
		expect(dcgMatchesShutdown("ls -la")).toBe(false);
	});
});
