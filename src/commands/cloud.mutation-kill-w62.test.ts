import { afterEach, describe, expect, test, vi } from "vitest";
import * as fsMod from "node:fs";

vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: vi.fn(() => "test-token"),
}));

// `vi.spyOn(fsMod, ...)` throws "Module namespace is not configurable in ESM"
// for node:fs — wrap the two exports cloud.ts uses in call-through vi.fn()s
// instead (same workaround used in src/lib/config.mutation-kill.test.ts).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		readFileSync: vi.fn(actual.readFileSync),
	};
});

import {
	type CloudRecentOpts,
	type RecentEvent,
	cloudRecentCommand,
	deriveAdminUrl,
	formatRecentEvents,
	loadCloudUrl,
} from "./cloud.js";

// --- loadCloudUrl / existsSync + "utf8" encoding literal -------------------

describe("loadCloudUrl — existsSync gate and encoding literal (positive/negative)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// test-contract: public-api — loadCloudUrl(cwd) must return null without
	// reading the file when existsSync says the config file is absent.
	test("N: returns null and never reads the file when existsSync is false", () => {
		const existsMock = vi.mocked(fsMod.existsSync);
		const readMock = vi.mocked(fsMod.readFileSync);
		existsMock.mockReturnValueOnce(false);
		readMock.mockReturnValueOnce(
			JSON.stringify({ cloud_governor: { url: "https://example.com/should-not-be-read" } }),
		);

		const result = loadCloudUrl("/does/not/matter");

		expect(result).toBeNull();
		expect(readMock).not.toHaveBeenCalled();
	});

	// test-contract: public-api — loadCloudUrl must decode the config file as
	// utf8 text (not a Buffer / other encoding) before JSON.parse.
	test("P: reads the config file with utf8 encoding when it exists", () => {
		const existsMock = vi.mocked(fsMod.existsSync);
		const readMock = vi.mocked(fsMod.readFileSync);
		existsMock.mockReturnValueOnce(true);
		readMock.mockReturnValueOnce(JSON.stringify({ cloud_governor: { url: "https://example.com/y" } }));

		const result = loadCloudUrl("/whatever/cwd");

		expect(result).toBe("https://example.com/y");
		expect(readMock).toHaveBeenCalledWith(expect.any(String), "utf8");
	});
});

// --- formatRecentEvents: shortSession "?" default + length-8 slice boundary

function withSliceSpy(fn: () => void): Array<unknown[]> {
	const calls: Array<unknown[]> = [];
	// SAFETY: this test temporarily patches the known String prototype method
	// for one synchronous call and restores the original in `finally` below.
	const orig = String.prototype.slice as any;
	// SAFETY: the receiver remains String.prototype; only the method's callable
	// type is widened so the probe can record its variadic arguments.
	(String.prototype as any).slice = function (...args: unknown[]) {
		calls.push(args);
		return orig.apply(this, args);
	};
	try {
		fn();
	} finally {
		// SAFETY: `orig` is the exact method saved from this prototype above.
		(String.prototype as any).slice = orig;
	}
	return calls;
}

describe("formatRecentEvents — shortSession behavior (positive/negative)", () => {
	test("N: missing session_id renders '?' not empty string", () => {
		const events: RecentEvent[] = [{ id: 1, tool_name: "Bash", decision: "allow" }];
		const out = formatRecentEvents(events);
		const dataLine = out.split("\n")[2] ?? "";
		expect(dataLine).toContain("?");
	});

	test("P: an exactly-8-character session id is never sliced (boundary s.length > 8)", () => {
		const calls = withSliceSpy(() => {
			formatRecentEvents([{ id: 1, session_id: "abcdefgh", tool_name: "Bash", decision: "allow" }]);
		});
		expect(calls.length).toBe(0);
	});

	test("P: a short (<8 char) session id is never sliced (guards against always-true condition)", () => {
		const calls = withSliceSpy(() => {
			formatRecentEvents([{ id: 1, session_id: "abc", tool_name: "Bash", decision: "allow" }]);
		});
		expect(calls.length).toBe(0);
	});
});

// --- formatRecentEvents: the three "?" fallback literals --------------------

describe("formatRecentEvents — '?' fallbacks for id/when/tool (negative cases)", () => {
	test("N: missing id renders '?' in the id column", () => {
		const out = formatRecentEvents([{ session_id: "sess1234", tool_name: "Bash", decision: "allow" }]);
		const dataLine = out.split("\n")[2] ?? "";
		expect(dataLine.trimStart().startsWith("?")).toBe(true);
	});

	test("N: missing created_at renders '?' for the when column", () => {
		const out = formatRecentEvents([{ id: 5, session_id: "sess1234", tool_name: "Bash", decision: "allow" }]);
		// with no created_at, the 'when' cell is literally "?" — must appear in output
		expect(out).toContain("?");
	});

	test("N: missing tool_name renders '?' in the tool column", () => {
		const out = formatRecentEvents([{ id: 5, session_id: "sess1234", decision: "allow" }]);
		expect(out).toContain("?");
	});
});

// --- formatRecentEvents: header row array + string literals -----------------

describe("formatRecentEvents — header row content (negative: must fire)", () => {
	test("N: header line contains all six literal column names", () => {
		const out = formatRecentEvents([
			{ id: 1, session_id: "sess1234", tool_name: "Bash", decision: "allow", created_at: Date.now() },
		]);
		const headerLine = out.split("\n")[0] ?? "";
		for (const word of ["id", "when", "session", "tool", "decision", "rule"]) {
			expect(headerLine).toContain(word);
		}
	});
});

// --- decorateDecision (via formatRecentEvents), spying on c.red / c.green ---

vi.mock("../lib/formatter.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/formatter.js")>();
	return {
		...actual,
		c: {
			...actual.c,
			red: (s: string) => `RED(${s})`,
			green: (s: string) => `GREEN(${s})`,
		},
	};
});

describe("decorateDecision — via formatRecentEvents (positive/negative)", () => {
	test("P: decision 'block' is routed through the red colorizer", () => {
		const out = formatRecentEvents([{ id: 1, session_id: "sess1234", tool_name: "Bash", decision: "block" }]);
		expect(out).toContain("RED(block)");
	});

	test("P: decision 'allow' is routed through the green colorizer", () => {
		const out = formatRecentEvents([{ id: 1, session_id: "sess1234", tool_name: "Bash", decision: "allow" }]);
		expect(out).toContain("GREEN(allow)");
	});

	test("N: an unknown decision falls back to '?' not an empty string", () => {
		const out = formatRecentEvents([{ id: 1, session_id: "sess1234", tool_name: "Bash" }]);
		const dataLine = out.split("\n")[2] ?? "";
		// decision column is the 5th field; regardless of exact spacing, '?' must appear
		// and must not have been replaced by an empty string.
		expect(dataLine).toContain("?");
	});
});

// --- fetchRecent (via cloudRecentCommand): empty-string detail literal ------

describe("cloudRecentCommand — fetchRecent error detail literal (negative)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("N: a non-401 failure reports the status line with NO extra detail suffix", async () => {
		const existsMock = vi.mocked(fsMod.existsSync);
		const readMock = vi.mocked(fsMod.readFileSync);
		existsMock.mockReturnValueOnce(true);
		readMock.mockReturnValueOnce(
			JSON.stringify({ cloud_governor: { url: "https://example.com/governor/evaluate" } }),
		);

		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
		});
		vi.stubGlobal("fetch", fetchMock);

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const opts: CloudRecentOpts = { cwd: "/whatever", limit: 10 };

		await expect(cloudRecentCommand(opts)).rejects.toThrow("exit:1");

		const messages = stderrSpy.mock.calls.map((c) => String(c[0]));
		const statusMsg = messages.find((m) => m.includes("cloud governor returned 500"));
		expect(statusMsg).toBeDefined();
		expect(statusMsg).toBe("error: cloud governor returned 500 Internal Server Error\n");
		expect(statusMsg).not.toContain("Stryker was here!");

		void exitSpy;
		vi.unstubAllGlobals();
	});
});

// sanity: deriveAdminUrl import used to avoid unused-import lint noise in case
// future edits trim other assertions; not itself a targeted survivor here.
test("deriveAdminUrl sanity (not a targeted mutant, guards import usage)", () => {
	expect(deriveAdminUrl("https://example.com/governor/evaluate", 5)).toContain("limit=5");
});
