import { describe, expect, it } from "vitest";
import {
	formatDebtEvasionStopLine,
	isInlineExecCommand,
	markDebtWanderBlocked,
	trackDebtEvasion,
} from "./debt-evasion.js";
import { SessionTracker } from "./session-state.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

function bash(command: string, sessionId = "s"): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: sessionId,
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		cwd: "/repo",
		timestamp: "t",
	};
}

function fresh(): SessionTrajectory {
	return new SessionTracker().recordEvent(bash("ls"));
}

describe("trackDebtEvasion — tool_name gate (kills 462141d3441d15a9)", () => {
	// test-contract: public-api — trackDebtEvasion must gate on tool_name === "Bash" before inspecting the command
	it("does not count a non-Bash event even if it carries an inline-exec-shaped command", () => {
		const s = fresh();
		markDebtWanderBlocked(s, 1000);
		const nonBash: HarnessEvent = {
			...bash(`node -e 'x'`),
			tool_name: "Read",
		};
		trackDebtEvasion(s, nonBash);
		expect(s.inline_exec_after_debt_block ?? 0).toBe(0);
	});
});

describe("trackDebtEvasion — raw type guard (kills a4a51401dd00e384)", () => {
	// test-contract: public-api — trackDebtEvasion must only act on a string tool_input.command
	it("treats a non-string tool_input.command as absent, not as the command itself", () => {
		const s = fresh();
		markDebtWanderBlocked(s, 1000);
		// A single-element array stringifies (via RegExp#test's ToString coercion)
		// to an inline-exec-shaped string, so if the guard is bypassed and the
		// raw value is used directly, isInlineExecCommand would still "see" it —
		// exposing the difference only through the explicit `command` typeof check.
		const event: HarnessEvent = {
			...bash("ls"),
			tool_input: { command: ["node -e 'x'"] },
		};
		trackDebtEvasion(s, event);
		expect(s.inline_exec_after_debt_block ?? 0).toBe(0);
	});
});

describe("trackDebtEvasion — optional chaining on tool_input (kills b46102afefdd27f2)", () => {
	// test-contract: boundary — optional chaining on tool_input must not throw when tool_input is undefined
	it("does not throw when tool_input is absent entirely", () => {
		const s = fresh();
		markDebtWanderBlocked(s, 1000);
		const event: HarnessEvent = { ...bash("ls"), tool_input: undefined };
		expect(() => trackDebtEvasion(s, event)).not.toThrow();
		expect(s.inline_exec_after_debt_block ?? 0).toBe(0);
	});
});

describe("formatDebtEvasionStopLine — exact wording (kills df9da0568b1394de, 6174b3c7d0bbed40)", () => {
	// test-contract: public-api — Stop-reflection copy is a documented user-facing contract of formatDebtEvasionStopLine
	it("carries the full first-sentence wording", () => {
		const s = fresh();
		markDebtWanderBlocked(s, 1);
		trackDebtEvasion(s, bash(`node -e '1'`));
		const line = formatDebtEvasionStopLine(s);
		expect(line).toContain(
			"piped heredoc) after a debt-focus block this session. Inline exec is invisible ",
		);
	});

	// test-contract: public-api — Stop-reflection copy is a documented user-facing contract of formatDebtEvasionStopLine
	it("carries the closing remedy sentence", () => {
		const s = fresh();
		markDebtWanderBlocked(s, 1);
		trackDebtEvasion(s, bash(`node -e '1'`));
		const line = formatDebtEvasionStopLine(s);
		expect(line).toContain("or keep working the debted pair instead.");
	});
});

describe("isInlineExecCommand — node/deno/bun eval flag spacing (kills 5a0d15a1ae8bae24)", () => {
	// test-contract: public-api — the eval-flag pattern must tolerate 1+ whitespace chars, not exactly one
	it("still matches with extra internal whitespace before the flag", () => {
		expect(isInlineExecCommand(`node  -e 'x'`)).toBe(true);
	});
});

describe("isInlineExecCommand — python -c prefix class (kills f4c7a29dfa41e669, 11090374c550a69e)", () => {
	// test-contract: public-api — the python -c pattern must accept a plain-space boundary, not just start-of-string
	it("matches when the boundary before python is a plain space, not start-of-string", () => {
		expect(isInlineExecCommand(`npx python -c 'y'`)).toBe(true);
	});
});

describe("isInlineExecCommand — python3? optional digit (kills 7e10e8ee0b933b5e)", () => {
	// test-contract: public-api — python3? must match plain "python" without the trailing digit
	it("matches plain python (no trailing 3) with -c", () => {
		expect(isInlineExecCommand(`python -c 'y'`)).toBe(true);
	});
});

describe("isInlineExecCommand — python -c spacing (kills 0e774aa34153b48f)", () => {
	// test-contract: public-api — the python -c pattern must tolerate 1+ whitespace chars, not exactly one
	it("still matches with extra internal whitespace before -c", () => {
		expect(isInlineExecCommand(`python3  -c 'y'`)).toBe(true);
	});
});

describe("isInlineExecCommand — ruby|perl prefix class (kills bff0b6282e39e5a8, 3a1c5a6868cb4b01)", () => {
	// test-contract: public-api — the ruby|perl -e pattern must accept a plain-space boundary, not just start-of-string
	it("matches when the boundary before ruby is a plain space, not start-of-string", () => {
		expect(isInlineExecCommand(`run ruby -e 'x'`)).toBe(true);
	});
});

describe("isInlineExecCommand — ruby|perl -e spacing (kills ee9684f863b00362)", () => {
	// test-contract: public-api — the ruby|perl -e pattern must tolerate 1+ whitespace chars, not exactly one
	it("still matches with extra internal whitespace before -e", () => {
		expect(isInlineExecCommand(`ruby  -e 'x'`)).toBe(true);
	});
});

describe("isInlineExecCommand — trailing-pipe end anchor (kills 9b7088ecf4e0041d)", () => {
	// test-contract: public-api — the piped-interpreter pattern requires the interpreter token to be the end of the command
	it("does NOT match when a piped interpreter has a trailing argument", () => {
		expect(isInlineExecCommand(`cat file.js | node script.js`)).toBe(false);
	});
});

describe("isInlineExecCommand — trailing-pipe optional space (kills dd06d0234d9ef46c)", () => {
	// test-contract: public-api — the piped-interpreter pattern must allow zero whitespace after the pipe
	it("matches a pipe into an interpreter with no space after the pipe", () => {
		expect(isInlineExecCommand(`cat x |node`)).toBe(true);
	});
});

describe("isInlineExecCommand — trailing-pipe python3? optional (kills 12c0e8d091c20776)", () => {
	// test-contract: public-api — python3? in the piped-interpreter pattern must match plain "python" too
	it("matches a pipe into plain python (no trailing 3)", () => {
		expect(isInlineExecCommand(`cat x | python`)).toBe(true);
	});
});

describe("isInlineExecCommand — trailing-pipe trailing whitespace (kills ba7dc782d93de385)", () => {
	// test-contract: public-api — the piped-interpreter pattern must allow trailing whitespace after the interpreter name
	it("matches when trailing whitespace follows the piped interpreter name", () => {
		expect(isInlineExecCommand(`cat x | node `)).toBe(true);
	});
});

describe("isInlineExecCommand — heredoc prefix class (kills 3565f9b616775b83, 154efd26a7341f24)", () => {
	// test-contract: public-api — the heredoc pattern must accept a plain-space boundary, not just start-of-string
	it("matches when the boundary before node is a plain space, not start-of-string", () => {
		expect(isInlineExecCommand(`run node <<EOF`)).toBe(true);
	});
});

describe("isInlineExecCommand — heredoc python3? optional (kills 7fbd236f7384b7ba)", () => {
	// test-contract: public-api — python3? in the heredoc pattern must match plain "python" too
	it("matches plain python (no trailing 3) feeding a heredoc", () => {
		expect(isInlineExecCommand(`python <<EOF`)).toBe(true);
	});
});

describe("isInlineExecCommand — heredoc middle-segment star (kills fefb8636ab1ca72f)", () => {
	// test-contract: public-api — the heredoc pattern's middle segment must allow zero characters, not require exactly one
	it("matches when there is zero gap between the interpreter and the heredoc marker", () => {
		expect(isInlineExecCommand(`node<<EOF`)).toBe(true);
	});
});

describe("isInlineExecCommand — heredoc whitespace after << (kills ab36a3229a1197ae)", () => {
	// test-contract: public-api — the heredoc pattern must allow whitespace between << and the marker
	it("matches when whitespace separates << from the heredoc word", () => {
		expect(isInlineExecCommand(`node << EOF`)).toBe(true);
	});
});

describe("isInlineExecCommand — heredoc optional quote and word-char marker (kills e82317e5b290f0e5, f771d46e2067ecd2)", () => {
	// test-contract: public-api — the heredoc quote is optional and the marker must be word characters
	it("matches an unquoted word-character heredoc marker", () => {
		expect(isInlineExecCommand(`node <<EOF`)).toBe(true);
	});
});
