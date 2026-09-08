import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudVerdict } from "../lib/cloud-governor.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

// --- Module-boundary mocks --------------------------------------------------
// `cloud-forward.ts` reaches the outside world through exactly three imports:
//   - node:fs           readFileSync (config file on disk)
//   - ../lib/auth.js    resolveAuthToken (OAuth bearer)
//   - ../lib/cloud-governor.js  evaluateRemote (the network call)
// We stub all three at the boundary so the unit under test runs with zero real
// I/O and fully deterministic inputs. `evaluateRemote` is the only thing that
// would otherwise touch the network, so mocking it also satisfies "no real
// network" without needing to stub global fetch.

const readFileSyncMock = vi.fn<(path: string, enc: string) => string>();
vi.mock("node:fs", () => ({
	readFileSync: (path: string, enc: string) => readFileSyncMock(path, enc),
}));

const resolveAuthTokenMock = vi.fn<(cwd?: string) => string | null>();
vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: (cwd?: string) => resolveAuthTokenMock(cwd),
}));

const evaluateRemoteMock =
	vi.fn<
		(
			event: HarnessEvent,
			config: {
				enabled: boolean;
				url: string;
				bearer_token: string;
				timeout_ms?: number;
			},
		) => Promise<CloudVerdict | null>
	>();
vi.mock("../lib/cloud-governor.js", () => ({
	evaluateRemote: (
		event: HarnessEvent,
		config: {
			enabled: boolean;
			url: string;
			bearer_token: string;
			timeout_ms?: number;
		},
	) => evaluateRemoteMock(event, config),
}));

// Import AFTER the mocks are registered so the SUT binds to the stubs.
const {
	forwardCloudPreToolUse,
	isMetaTestWrapper,
	mergeCloudVerdict,
	_resetCloudConfigCache,
} = await import("./cloud-forward.js");

// --- Fixtures ---------------------------------------------------------------

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command: "ls" },
		timestamp: "2026-05-28T00:00:00Z",
		...overrides,
	};
}

const ALLOW_LOCAL: HarnessDecision = { decision: "allow" };
const ALLOW_LOCAL_WITH_WARNINGS: HarnessDecision = {
	decision: "allow",
	warnings: ["[interlinked] local warn"],
};
const BLOCK_LOCAL: HarnessDecision = { decision: "block", reason: "blocked locally" };
const ASK_LOCAL: HarnessDecision = { decision: "ask", reason: "asking" };

/** Serialize a `cloud_governor` block exactly as it lives in config.local.json. */
function configFileWith(cloudGovernor: unknown): string {
	return JSON.stringify({ cloud_governor: cloudGovernor });
}

const CWD = "/repo";

beforeEach(() => {
	readFileSyncMock.mockReset();
	resolveAuthTokenMock.mockReset();
	evaluateRemoteMock.mockReset();
	// The module-level config cache is sticky across calls by design; reset it
	// before every test so each test sees a fresh read of its own fixture.
	_resetCloudConfigCache();
});

afterEach(() => {
	_resetCloudConfigCache();
});

// ---------------------------------------------------------------------------
// loadCloudConfig — exercised through forwardCloudPreToolUse (it is private).
// Each branch is isolated by what `readFileSync` returns / throws.
// ---------------------------------------------------------------------------

describe("loadCloudConfig (via forwardCloudPreToolUse)", () => {
	it("returns local decision when the config file cannot be read (catch → null)", async () => {
		readFileSyncMock.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		// Read against the expected path; auth/network never reached.
		expect(readFileSyncMock).toHaveBeenCalledWith(
			"/repo/.interlinked/config.local.json",
			"utf8",
		);
		expect(resolveAuthTokenMock).not.toHaveBeenCalled();
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("treats a missing cloud_governor key as no-config (cg falsy → null)", async () => {
		readFileSyncMock.mockReturnValue(JSON.stringify({ something_else: 1 }));
		resolveAuthTokenMock.mockReturnValue("tok");
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("treats a non-object cloud_governor as no-config (typeof !== object → null)", async () => {
		readFileSyncMock.mockReturnValue(configFileWith("a string, not an object"));
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("treats a null cloud_governor as no-config (cg === null → null)", async () => {
		// isJsonObject rejects null explicitly (typeof null === "object" alone
		// would not have been enough).
		readFileSyncMock.mockReturnValue(configFileWith(null));
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("N: treats an array cloud_governor as no-config (isJsonObject rejects arrays, not just non-objects)", async () => {
		// typeof [] === "object", so a check that only excluded non-objects would
		// let an array through to the enabled/url checks; isJsonObject rejects it
		// up front instead.
		readFileSyncMock.mockReturnValue(configFileWith([1, 2, 3]));
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("rejects config when enabled is not a boolean (→ null)", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: "yes", url: "https://gov.example" }),
		);
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("rejects config when url is not a string (→ null)", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: 12345 }),
		);
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("parses a valid config WITHOUT timeout_ms (ternary → undefined, key omitted)", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue(null);
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(evaluateRemoteMock).toHaveBeenCalledTimes(1);
		const cfg = evaluateRemoteMock.mock.calls[0]![1];
		expect(cfg).toEqual({
			enabled: true,
			url: "https://gov.example",
			bearer_token: "tok",
		});
		// exactOptionalPropertyTypes contract: the key must be absent, not
		// present-with-undefined, when timeout_ms is missing.
		expect(Object.hasOwn(cfg, "timeout_ms")).toBe(false);
	});

	it("parses a valid config WITH a numeric timeout_ms (ternary → spread)", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example", timeout_ms: 750 }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue(null);
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(evaluateRemoteMock.mock.calls[0]![1]).toEqual({
			enabled: true,
			url: "https://gov.example",
			bearer_token: "tok",
			timeout_ms: 750,
		});
	});

	it("ignores a non-numeric timeout_ms (config-load ternary → undefined)", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({
				enabled: true,
				url: "https://gov.example",
				timeout_ms: "soon",
			}),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue(null);
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		const cfg = evaluateRemoteMock.mock.calls[0]![1];
		expect(Object.hasOwn(cfg, "timeout_ms")).toBe(false);
	});

	it("caches the config: a second call does not re-read the file", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue(null);
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		// Read exactly once despite two forwards (configLoaded short-circuit).
		expect(readFileSyncMock).toHaveBeenCalledTimes(1);
		expect(evaluateRemoteMock).toHaveBeenCalledTimes(2);
	});

	it("caches a null result too: a failed read is not retried", async () => {
		readFileSyncMock.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		// Second call hits the `configLoaded` short-circuit, returning cached null.
		expect(readFileSyncMock).toHaveBeenCalledTimes(1);
	});
});

describe("_resetCloudConfigCache", () => {
	it("forces a re-read after reset (config can change between resets)", async () => {
		readFileSyncMock.mockReturnValueOnce(
			configFileWith({ enabled: false, url: "https://gov.example" }),
		);
		// First load: disabled → local decision, no network.
		expect(await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD)).toBe(ALLOW_LOCAL);
		expect(readFileSyncMock).toHaveBeenCalledTimes(1);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();

		// Without reset the cache would stick; reset + new fixture flips behavior.
		_resetCloudConfigCache();
		readFileSyncMock.mockReturnValueOnce(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue(null);
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(readFileSyncMock).toHaveBeenCalledTimes(2);
		expect(evaluateRemoteMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// forwardCloudPreToolUse — the orchestration branches.
// ---------------------------------------------------------------------------

describe("forwardCloudPreToolUse", () => {
	it("short-circuits a meta-test wrapper to the local decision (no config read)", async () => {
		const event = makeEvent({
			tool_input: { command: 'interlinked harness test "rm -rf /"' },
		});
		const result = await forwardCloudPreToolUse(event, BLOCK_LOCAL, CWD);
		expect(result).toBe(BLOCK_LOCAL);
		// The wrapper guard runs before loadCloudConfig — nothing downstream fires.
		expect(readFileSyncMock).not.toHaveBeenCalled();
		expect(resolveAuthTokenMock).not.toHaveBeenCalled();
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("returns local decision when config is disabled (config.enabled false)", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: false, url: "https://gov.example" }),
		);
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(resolveAuthTokenMock).not.toHaveBeenCalled();
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("returns local decision when there is no auth token (resolveAuthToken null)", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue(null);
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		expect(result).toBe(ALLOW_LOCAL);
		expect(resolveAuthTokenMock).toHaveBeenCalledWith(CWD);
		expect(evaluateRemoteMock).not.toHaveBeenCalled();
	});

	it("forwards the event and merges a cloud BLOCK into a local allow", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue({ decision: "block", reason: "cloud says no" });
		const event = makeEvent();
		const result = await forwardCloudPreToolUse(event, ALLOW_LOCAL, CWD);
		expect(result.decision).toBe("block");
		expect(result.reason).toBe("[cloud] cloud says no");
		// The exact event object is forwarded unchanged to the governor.
		expect(evaluateRemoteMock).toHaveBeenCalledWith(event, expect.objectContaining({
			enabled: true,
			url: "https://gov.example",
			bearer_token: "tok",
		}));
	});

	it("merges cloud warnings into a local allow", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue({ decision: "allow", warnings: ["careful"] });
		const result = await forwardCloudPreToolUse(
			makeEvent(),
			ALLOW_LOCAL_WITH_WARNINGS,
			CWD,
		);
		expect(result.decision).toBe("allow");
		expect(result.warnings).toEqual(["[interlinked] local warn", "[cloud] careful"]);
	});

	it("returns the local decision unchanged when the governor returns null", async () => {
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue(null);
		const result = await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL, CWD);
		// mergeCloudVerdict(local, null) === local
		expect(result).toBe(ALLOW_LOCAL);
	});

	it("defaults cwd to process.cwd() when omitted", async () => {
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/from-process-cwd");
		readFileSyncMock.mockReturnValue(
			configFileWith({ enabled: true, url: "https://gov.example" }),
		);
		resolveAuthTokenMock.mockReturnValue("tok");
		evaluateRemoteMock.mockResolvedValue(null);
		// Call with only the two required args — cwd falls back to the default.
		await forwardCloudPreToolUse(makeEvent(), ALLOW_LOCAL);
		expect(readFileSyncMock).toHaveBeenCalledWith(
			"/from-process-cwd/.interlinked/config.local.json",
			"utf8",
		);
		// resolveAuthToken receives the same defaulted cwd.
		expect(resolveAuthTokenMock).toHaveBeenCalledWith("/from-process-cwd");
		spy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// isMetaTestWrapper — pure predicate, every branch.
// ---------------------------------------------------------------------------

describe("isMetaTestWrapper", () => {
	it("matches `interlinked harness test <inner>` on Bash", () => {
		expect(
			isMetaTestWrapper(
				makeEvent({ tool_input: { command: 'interlinked harness test "rm -rf /"' } }),
			),
		).toBe(true);
	});

	it("matches with leading whitespace", () => {
		expect(
			isMetaTestWrapper(makeEvent({ tool_input: { command: '   interlinked harness test "x"' } })),
		).toBe(true);
	});

	it("matches on Shell and run_command tool names", () => {
		expect(
			isMetaTestWrapper(
				makeEvent({ tool_name: "Shell", tool_input: { command: "interlinked harness test x" } }),
			),
		).toBe(true);
		expect(
			isMetaTestWrapper(
				makeEvent({
					tool_name: "run_command",
					tool_input: { command: "interlinked harness test x" },
				}),
			),
		).toBe(true);
	});

	it("does NOT match a non-shell tool even with a command-shaped input", () => {
		expect(
			isMetaTestWrapper(
				makeEvent({ tool_name: "Edit", tool_input: { command: "interlinked harness test x" } }),
			),
		).toBe(false);
	});

	it("does NOT match other interlinked subcommands", () => {
		expect(
			isMetaTestWrapper(makeEvent({ tool_input: { command: "interlinked harness restart" } })),
		).toBe(false);
		expect(
			isMetaTestWrapper(makeEvent({ tool_input: { command: "interlinked allowlist add npm x" } })),
		).toBe(false);
	});

	it("does NOT match when command is missing or non-string", () => {
		expect(isMetaTestWrapper(makeEvent({ tool_input: {} }))).toBe(false);
		expect(isMetaTestWrapper(makeEvent({ tool_input: undefined }))).toBe(false);
		// Non-string command value exercises the `typeof command === "string"` arm.
		expect(
			isMetaTestWrapper(makeEvent({ tool_input: { command: 123 } })),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// mergeCloudVerdict — pure merge, every branch.
// ---------------------------------------------------------------------------

describe("mergeCloudVerdict", () => {
	it("returns local unchanged when cloud verdict is null", () => {
		expect(mergeCloudVerdict(ALLOW_LOCAL, null)).toBe(ALLOW_LOCAL);
	});

	it("returns local unchanged when local already blocks (cloud cannot loosen)", () => {
		const cloud: CloudVerdict = { decision: "allow" };
		expect(mergeCloudVerdict(BLOCK_LOCAL, cloud)).toBe(BLOCK_LOCAL);
	});

	it("returns local unchanged when local is ask", () => {
		const cloud: CloudVerdict = { decision: "block", reason: "cloud block" };
		expect(mergeCloudVerdict(ASK_LOCAL, cloud)).toBe(ASK_LOCAL);
	});

	it("escalates allow → block when cloud blocks, prefixing the reason", () => {
		const cloud: CloudVerdict = { decision: "block", reason: "cloud says no" };
		const merged = mergeCloudVerdict(ALLOW_LOCAL, cloud);
		expect(merged.decision).toBe("block");
		expect(merged.reason).toBe("[cloud] cloud says no");
	});

	it("uses the fallback reason when cloud block omits a reason (?? branch)", () => {
		const cloud: CloudVerdict = { decision: "block" };
		const merged = mergeCloudVerdict(ALLOW_LOCAL, cloud);
		expect(merged.decision).toBe("block");
		expect(merged.reason).toBe("[cloud] blocked by cloud governor");
	});

	it("unions cloud warnings into a local allow with no existing warnings (?? [] branch)", () => {
		const cloud: CloudVerdict = { decision: "allow", warnings: ["cloud warn"] };
		const merged = mergeCloudVerdict(ALLOW_LOCAL, cloud);
		expect(merged.decision).toBe("allow");
		expect(merged.warnings).toEqual(["[cloud] cloud warn"]);
	});

	it("appends cloud warnings after existing local warnings", () => {
		const cloud: CloudVerdict = { decision: "allow", warnings: ["cloud warn"] };
		const merged = mergeCloudVerdict(ALLOW_LOCAL_WITH_WARNINGS, cloud);
		expect(merged.warnings).toEqual(["[interlinked] local warn", "[cloud] cloud warn"]);
	});

	it("leaves local allow unchanged when cloud allows with no warnings (length 0 short-circuit)", () => {
		const cloud: CloudVerdict = { decision: "allow" };
		const merged = mergeCloudVerdict(ALLOW_LOCAL_WITH_WARNINGS, cloud);
		// Returns the original object reference: no warnings to merge.
		expect(merged).toBe(ALLOW_LOCAL_WITH_WARNINGS);
	});

	it("leaves local allow unchanged when cloud allows with an empty warnings array", () => {
		const cloud: CloudVerdict = { decision: "allow", warnings: [] };
		const merged = mergeCloudVerdict(ALLOW_LOCAL, cloud);
		expect(merged).toBe(ALLOW_LOCAL);
	});
});
