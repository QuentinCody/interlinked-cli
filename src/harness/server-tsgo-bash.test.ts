// TSC-to-tsgo acceleration behavior and whitespace regressions.
// Keep a static SUT import so mutation test selection follows this suite.

import type { SpawnSyncReturns, SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	_resetTsgoAvailabilityCache,
	isBashTsc,
	isTsgoAvailable,
	tryTsgoRewrite,
} from "./server-tsgo-bash.js";

const spawnSyncMock = vi.hoisted(() => vi.fn<(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>>());

vi.mock("node:child_process", () => ({
	spawnSync: spawnSyncMock,
}));

function spawnResult(over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		...over,
	};
}

/** True when this spawnSync call is the `npx tsgo --version` availability probe. */
function isVersionProbe(args: unknown[]): boolean {
	const [cmd, argv] = args;
	return cmd === "npx" && Array.isArray(argv) && argv[0] === "tsgo" && argv[1] === "--version";
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	_resetTsgoAvailabilityCache();
});

// ---------------------------------------------------------------------------
// isTsgoAvailable
// ---------------------------------------------------------------------------

describe("isTsgoAvailable", () => {
	it("returns true when `npx tsgo --version` exits 0 with no error, and passes correct args/opts", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		expect(isTsgoAvailable()).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, argv, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("npx");
		expect(argv).toEqual(["tsgo", "--version"]);
		expect(opts).toMatchObject({
			timeout: 5_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns false when the probe exits non-zero", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1 }));
		expect(isTsgoAvailable()).toBe(false);
	});

	it("returns false when the probe sets result.error even with status 0", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, error: new Error("ENOENT") }));
		expect(isTsgoAvailable()).toBe(false);
	});

	it("returns false from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(isTsgoAvailable()).toBe(false);
	});

	it("memoizes: probes only once across repeated calls (true)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		expect(isTsgoAvailable()).toBe(true);
		expect(isTsgoAvailable()).toBe(true);
		expect(isTsgoAvailable()).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("memoizes a false result too (no re-probe after failure)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1 }));
		expect(isTsgoAvailable()).toBe(false);
		expect(isTsgoAvailable()).toBe(false);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// _resetTsgoAvailabilityCache  (ported from integration.test.ts)
// ---------------------------------------------------------------------------

describe("_resetTsgoAvailabilityCache", () => {
	it("clears memoization so the next call re-probes (false → true)", () => {
		spawnSyncMock.mockReturnValueOnce(spawnResult({ status: 1 }));
		expect(isTsgoAvailable()).toBe(false);

		_resetTsgoAvailabilityCache();

		spawnSyncMock.mockReturnValueOnce(spawnResult({ status: 0 }));
		expect(isTsgoAvailable()).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// isBashTsc — matching  (ported from integration.test.ts)
// ---------------------------------------------------------------------------

describe("isBashTsc — matching", () => {
	it("matches bare `tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc" } })).toBe(true);
	});
	it("matches `tsc --noEmit`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --noEmit" } })).toBe(true);
	});
	it("matches `npx tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" } })).toBe(
			true,
		);
	});
	it("matches chained `cd foo && tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "cd x && tsc --noEmit" } })).toBe(
			true,
		);
	});
	it("matches tsc chained after a pipe", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "echo hi | tsc" } })).toBe(true);
	});
	it("matches chained `npx tsc` after a semicolon", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "ls; npx tsc" } })).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// isBashTsc — non-matching  (ported from integration.test.ts)
// ---------------------------------------------------------------------------

describe("isBashTsc — non-matching", () => {
	it.each([
		'rg -n "beforeEach|tsc-overlay.js" src/harness/check-engine/index.test.ts',
		'echo "next; tsc --noEmit"',
		"tsc-wrapper --noEmit",
		"echo hi # ; tsc --noEmit",
		"echo $(date); tsc --noEmit",
	])("does not accelerate quoted data, look-alike names, or complex shell syntax: %s", (command) => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command } })).toBe(false);
	});

	it("does not match non-Bash tools", () => {
		expect(isBashTsc({ tool_name: "Read", tool_input: { command: "tsc" } })).toBe(false);
	});
	it("does not match a missing tool_name", () => {
		expect(isBashTsc({ tool_input: { command: "tsc" } })).toBe(false);
	});
	it("does not match when tsgo already in use", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx tsgo --noEmit" } })).toBe(
			false,
		);
	});
	it("does not match --build mode (long and short flags)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --build" } })).toBe(false);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -b" } })).toBe(false);
	});
	it("does not match --watch mode (long and short flags)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --watch" } })).toBe(false);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -w" } })).toBe(false);
	});
	it("does not match --declaration / --emitDeclarationOnly", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --declaration" } })).toBe(
			false,
		);
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --emitDeclarationOnly" } }),
		).toBe(false);
	});
	it("does not match -d short declaration flag", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -d" } })).toBe(false);
	});
	it("does not match --incremental / --composite", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --incremental" } })).toBe(
			false,
		);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --composite" } })).toBe(
			false,
		);
	});
	it("does not match --init / --generateTrace", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --init" } })).toBe(false);
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --generateTrace trace" } }),
		).toBe(false);
	});
	it("does not match tsc mentioned inside a string", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "echo 'run tsc later'" } })).toBe(
			false,
		);
	});
	it("does not match missing tool_input", () => {
		expect(isBashTsc({ tool_name: "Bash" })).toBe(false);
	});
	it("does not match an empty / whitespace command (the `|| ''` + trim fallback)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "" } })).toBe(false);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "   " } })).toBe(false);
	});
	it("does not match a non-string command (coerced via `|| ''`)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: undefined } })).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// tryTsgoRewrite  (ported from integration.test.ts)
// ---------------------------------------------------------------------------

describe("tryTsgoRewrite", () => {
	it("rewrites the executable compiler while preserving earlier quoted compiler text", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const command = "echo 'tsc label' && npx tsc --noEmit";
		expect(tryTsgoRewrite({ tool_input: { command } }, "/w", () => {})).not.toBeNull();
		expect(spawnSyncMock).toHaveBeenLastCalledWith("sh", ["-c", "echo 'tsc label' && npx tsgo --noEmit"], expect.objectContaining({ cwd: "/w" }));
	});

	it("refuses a direct rewrite of a search command without probing or executing it", () => {
		const command = 'rg "beforeEach|tsc-overlay.js" src';
		expect(tryTsgoRewrite({ tool_input: { command } }, "/w", () => {})).toBeNull();
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("returns null without spawning when tsgo is unavailable", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1 })); // version probe fails
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc --noEmit" } }, "/work", log);
		expect(out).toBeNull();
		// Only the version probe ran; no `sh -c` rewrite spawn.
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(log).not.toHaveBeenCalled();
	});

	it("rewrites `npx tsc` → `npx tsgo`, runs it, and returns a block with the output", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "all good\n" });
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "npx tsc --noEmit" } }, "/work", log);
		expect(out).toEqual({
			decision: "block",
			reason: [
				"[interlinked:tsgo] Accelerated with tsgo (native TypeScript compiler)",
				"$ npx tsgo --noEmit",
				"all good",
			].join("\n"),
		});
		// The rewritten command is the second spawnSync call, via `sh -c`.
		const rewriteCall = nonNull(spawnSyncMock.mock.calls[1]);
		expect(rewriteCall[0]).toBe("sh");
		expect(rewriteCall[1]).toEqual(["-c", "npx tsgo --noEmit"]);
		expect(rewriteCall[2]).toMatchObject({
			cwd: "/work",
			timeout: 120_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		// log fires once: the acceleration banner.
		expect(log).toHaveBeenCalledTimes(1);
		expect(nonNull(log.mock.calls[0])[0]).toContain("tsgo acceleration:");
		expect(nonNull(log.mock.calls[0])[0]).toContain("→");
	});

	it("rewrites bare `tsc` → `npx tsgo` (adds the npx prefix)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc --noEmit" } }, "/r", () => {});
		const rewriteCall = nonNull(spawnSyncMock.mock.calls[1]);
		expect(rewriteCall[1]).toEqual(["-c", "npx tsgo --noEmit"]);
		expect(out).not.toBeNull();
	});

	it("concatenates stdout + stderr in the block output", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "out-part", stderr: "err-part" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", () => {});
		expect(out?.reason).toContain("out-parterr-part");
	});

	it("emits `(no output)` when tsgo runs clean but prints nothing", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "", stderr: "" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", () => {});
		expect(out?.reason.split("\n")).toContain("(no output)");
	});

	it("falls back (null) and logs when the rewrite leaves only whitespace output but clean exit", () => {
		// `output` is trimmed to "" so the `(no output)` branch is taken — exit
		// is clean, so this is still a block, not a fallback. Distinct from the
		// non-zero cases below.
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "   \n  " });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", () => {});
		expect(out?.reason.split("\n")).toContain("(no output)");
	});

	it("falls back to tsc (null) and logs when tsgo exits non-zero", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 2, stdout: "type error\n" });
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(log).toHaveBeenCalledTimes(2); // banner + "falling back"
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo exited 2, falling back to tsc");
	});

	it("treats a null exit status as 1 (the `?? 1` fallback) and falls back", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: null, stdout: "" });
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo exited 1, falling back to tsc");
	});

	it("returns null from the catch block when the rewrite spawnSync throws (Error)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			throw new Error("spawn blew up");
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(log).toHaveBeenCalledTimes(2);
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo acceleration failed: spawn blew up");
	});

	it("returns null from the catch block when the thrown value is not an Error (String fallback)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			// Non-Error throw exercises the `String(err)` branch in the catch.
			throw "string failure";
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo acceleration failed: string failure");
	});

	it.each([undefined, null, 42, {}])("declines a non-text command without launching a subprocess: %j", (command) => {
		expect(tryTsgoRewrite({ tool_input: { command } }, "/r", () => {})).toBeNull();
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// isBashTsc — regex/whitespace boundary cases
// ---------------------------------------------------------------------------

describe("isBashTsc — regex/whitespace boundary cases (kill-brief hardening)", () => {
	it("P1: double space between `npx` and `tsc` still matches (kills the leading regex's \\s+ -> \\s mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx  tsc --noEmit" } })).toBe(
			true,
		);
	});

	it("P2: zero spaces after a `;` separator still matches (kills the chained regex's \\s* -> \\s mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "ls;tsc" } })).toBe(true);
	});

	it("P3: two spaces between a separator's `npx` and `tsc` still matches (kills the chained regex's inner npx \\s+ -> \\s mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "ls; npx  tsc" } })).toBe(true);
	});

	it("P4: leading/trailing whitespace around a bare `tsc` command still matches (kills the cmd.trim() removal mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "  tsc --noEmit  " } })).toBe(
			true,
		);
	});

	it("N1: a command that already mentions tsgo is never treated as a tsc command, even with a real tsc chained right after it (kills the tsgo-check ConditionalExpression->false mutant)", () => {
		expect(
			isBashTsc({
				tool_name: "Bash",
				tool_input: { command: "npx tsgo --version; tsc --noEmit" },
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// tryTsgoRewrite — regex + trim/slice boundary cases
// ---------------------------------------------------------------------------

describe("tryTsgoRewrite — regex + trim/slice boundary cases (kill-brief hardening)", () => {
	it("P5: double space between `npx` and `tsc` still rewrites the WHOLE prefix (kills tryTsgoRewrite's own replace-regex \\s+ -> \\s mutant)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "ok" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "npx  tsc --noEmit" } }, "/r", () => {});
		const rewriteCall = nonNull(spawnSyncMock.mock.calls[1]);
		expect(rewriteCall[1]).toEqual(["-c", "npx tsgo --noEmit"]);
		expect(out).not.toBeNull();
	});

	it("P6: the acceleration banner is trim()+slice(0,60)-exact on both sides of the arrow (kills 4 MethodExpression mutants that drop .trim()/.slice(0,60) on cmd/rewritten)", () => {
		const raw = `   tsc ${"x".repeat(70)}   `;
		const rewritten = raw.replace(/\b(npx\s+)?tsc\b/, "npx tsgo");
		const expectedBanner = `tsgo acceleration: ${raw.trim().slice(0, 60)} → ${rewritten
			.trim()
			.slice(0, 60)}`;

		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "ok" });
		});
		const log = vi.fn();
		tryTsgoRewrite({ tool_input: { command: raw } }, "/w", log);

		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toBe(expectedBanner);
	});
});
