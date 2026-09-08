import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
// Behavioral tests for `interlinked rewind` — restores the working tree to a
// checkpoint state. The command has two top-level paths: (1) a list shorthand
// (when `--list` is passed OR no checkpoint id is given) that delegates to
// `checkpointListCommand` via a dynamic `import("./checkpoint.js")`, and
// (2) the rewind path that calls `rewindToCheckpoint` and renders the result
// in json / normal mode, with a try/catch around the restore.
//
// Strategy: mock the I/O boundary (`../lib/checkpoints.js` for the restore),
// the dynamically-imported `./checkpoint.js` (so the list shorthand is
// observable without touching disk), and the two presentation modules
// (`../lib/formatter.js` identity-colored so we assert plain strings,
// `../lib/output.js` re-implemented faithfully so the mode branches stay
// intact while routing through console). console.log / console.error are
// spied; `outputError` sets `process.exitCode = 1`, so we assert the code
// rather than a thrown `process.exit`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Mocks
// ===========================================

const mockRewindToCheckpoint = vi.fn();
vi.mock("../lib/checkpoints.js", () => ({
	rewindToCheckpoint: (id: string, opts: unknown) => mockRewindToCheckpoint(id, opts),
}));

// The list shorthand does `await import("./checkpoint.js")` then calls
// checkpointListCommand. Mock the module so the delegation is observable and
// we can assert the exact args forwarded.
const mockCheckpointListCommand = vi.fn();
vi.mock("./checkpoint.js", () => ({
	checkpointListCommand: (opts: unknown) => mockCheckpointListCommand(opts),
}));

// Identity color helpers + predictable kvLine so we can assert on plain
// strings (no ANSI). kvLine mirrors the real "key: value" shape.
vi.mock("../lib/formatter.js", () => {
	const identity = (s: string) => s;
	return {
		c: {
			bold: identity,
			dim: identity,
			italic: identity,
			red: identity,
			green: identity,
			yellow: identity,
			blue: identity,
			magenta: identity,
			cyan: identity,
			gray: identity,
			white: identity,
		},
		kvLine: (key: string, value: string) => `${key}: ${value}`,
	};
});

// Faithful re-implementation of the output module: keeps the source's
// branch-by-mode logic intact while routing through console for assertions.
vi.mock("../lib/output.js", () => ({
	getOutputMode: (o: { json?: boolean; short?: boolean; full?: boolean }) => {
		if (o.json) return "json";
		if (o.short) return "short";
		if (o.full) return "full";
		return "normal";
	},
	output: (
		mode: string,
		data: unknown,
		renderers: {
			json?: () => unknown;
			short?: () => string;
			normal: () => string;
			full?: () => string;
		},
	) => {
		switch (mode) {
			case "json":
				console.log(JSON.stringify(renderers.json ? renderers.json() : data, null, 2));
				break;
			case "short":
				console.log(renderers.short ? renderers.short() : renderers.normal());
				break;
			case "full":
				console.log(renderers.full ? renderers.full() : renderers.normal());
				break;
			default:
				console.log(renderers.normal());
		}
	},
	outputError: (mode: string, message: string, details?: unknown) => {
		if (mode === "json") {
			console.error(JSON.stringify({ error: message, details }, null, 2));
		} else {
			console.error(`Error: ${message}`);
		}
		process.exitCode = 1;
	},
}));

// Imported after the mocks are declared so the SUT binds to them.
import { rewindCommand } from "./rewind.js";

// ===========================================
// Test helpers
// ===========================================

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function callsToString(spy: ReturnType<typeof vi.spyOn>): string {
	const calls = spy.mock.calls;
	return calls.map((call: unknown[]) => call.map((arg: unknown) => String(arg)).join(" ")).join("\n");
}

function logged(): string {
	return callsToString(logSpy);
}

function errored(): string {
	return callsToString(errSpy);
}

function loggedJson(): Record<string, unknown> {
	return parseWire(JSON.parse(logged()), wireRecord(wireUnknown), "test JSON value");
}

/** Build a successful RewindResult; `warning` omitted unless provided. */
function rewindResult(over: {
	success?: boolean;
	files_restored?: string[];
	warning?: string;
}): { success: boolean; files_restored: string[]; warning?: string } {
	return {
		success: over.success ?? true,
		files_restored: over.files_restored ?? [],
		...(over.warning !== undefined ? { warning: over.warning } : {}),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

// ===========================================
// List shorthand (--list OR no checkpoint id)
// ===========================================

describe("rewindCommand — list shorthand", () => {
	it("delegates to checkpointListCommand when no checkpoint id is given", async () => {
		await rewindCommand(undefined, {});
		expect(mockCheckpointListCommand).toHaveBeenCalledTimes(1);
		// json undefined → empty options object forwarded (no `json` key).
		expect(mockCheckpointListCommand).toHaveBeenCalledWith({});
		// The restore boundary must never be touched on the list path.
		expect(mockRewindToCheckpoint).not.toHaveBeenCalled();
	});

	it("delegates to checkpointListCommand when --list is passed (even with an id)", async () => {
		await rewindCommand("cp-123", { list: true });
		expect(mockCheckpointListCommand).toHaveBeenCalledTimes(1);
		// json is undefined on these opts -> forwarded as {} (no json key),
		// distinguishing this from the sibling --list --json test below.
		expect(mockCheckpointListCommand).toHaveBeenCalledWith({});
		expect(mockRewindToCheckpoint).not.toHaveBeenCalled();
	});

	it("forwards json:true to the list command when --list --json", async () => {
		await rewindCommand("cp-123", { list: true, json: true });
		expect(mockCheckpointListCommand).toHaveBeenCalledWith({ json: true });
	});

	it("forwards json:false explicitly when json is set false", async () => {
		// json !== undefined (it's false) → the ternary forwards { json: false }.
		await rewindCommand(undefined, { json: false });
		expect(mockCheckpointListCommand).toHaveBeenCalledWith({ json: false });
	});

	it("forwards an empty options object when called with no opts at all", async () => {
		// opts is undefined → !checkpointId true → opts?.json is undefined → {}.
		await rewindCommand();
		expect(mockCheckpointListCommand).toHaveBeenCalledWith({});
		expect(mockRewindToCheckpoint).not.toHaveBeenCalled();
	});
});

// ===========================================
// Rewind path — argument forwarding
// ===========================================

describe("rewindCommand — restore invocation", () => {
	it("calls rewindToCheckpoint with the id and an empty opts object when force is absent", async () => {
		mockRewindToCheckpoint.mockReturnValue(rewindResult({ files_restored: ["a.ts"] }));
		await rewindCommand("cp-abc", { json: true });
		expect(mockRewindToCheckpoint).toHaveBeenCalledTimes(1);
		// force undefined → the spread yields {} (no `force` key).
		expect(mockRewindToCheckpoint).toHaveBeenCalledWith("cp-abc", {});
	});

	it("forwards force:true into the restore options", async () => {
		mockRewindToCheckpoint.mockReturnValue(rewindResult({ files_restored: ["a.ts"] }));
		await rewindCommand("cp-abc", { force: true, json: true });
		expect(mockRewindToCheckpoint).toHaveBeenCalledWith("cp-abc", { force: true });
	});

	it("forwards force:false explicitly when force is set false", async () => {
		// force !== undefined (false) → { force: false } forwarded.
		mockRewindToCheckpoint.mockReturnValue(rewindResult({ files_restored: [] }));
		await rewindCommand("cp-abc", { force: false, json: true });
		expect(mockRewindToCheckpoint).toHaveBeenCalledWith("cp-abc", { force: false });
	});
});

// ===========================================
// Rewind path — normal mode rendering
// ===========================================

describe("rewindCommand — normal mode output", () => {
	it("renders the success line, count, and no warning when warning is absent", async () => {
		mockRewindToCheckpoint.mockReturnValue(
			rewindResult({ files_restored: ["src/a.ts", "src/b.ts"] }),
		);
		await rewindCommand("cp-xyz", {});
		const out = logged();
		expect(out).toContain("Rewound to checkpoint cp-xyz");
		expect(out).toContain("Files restored: 2");
		expect(out).not.toContain("Warning:");
		expect(process.exitCode).toBe(0);
	});

	it("renders zero files restored when nothing changed", async () => {
		mockRewindToCheckpoint.mockReturnValue(rewindResult({ files_restored: [] }));
		await rewindCommand("cp-empty", {});
		expect(logged()).toContain("Files restored: 0");
	});

	it("appends the warning line when result.warning is present", async () => {
		mockRewindToCheckpoint.mockReturnValue(
			rewindResult({ files_restored: ["a.ts"], warning: "stash could not be dropped" }),
		);
		await rewindCommand("cp-warn", {});
		const out = logged();
		expect(out).toContain("Rewound to checkpoint cp-warn");
		expect(out).toContain("Files restored: 1");
		expect(out).toContain("Warning: stash could not be dropped");
	});

	it("renders the failure line when result.success is false", async () => {
		mockRewindToCheckpoint.mockReturnValue(rewindResult({ success: false, files_restored: [] }));
		await rewindCommand("cp-fail", {});
		const out = logged();
		expect(out).toContain("Rewind failed");
		// The success-only lines must NOT appear on the failure branch.
		expect(out).not.toContain("Rewound to checkpoint");
		expect(out).not.toContain("Files restored:");
	});

	it("does not render the warning on the failure branch even if warning is set", async () => {
		// success:false short-circuits the whole success block (warning included).
		mockRewindToCheckpoint.mockReturnValue(
			rewindResult({ success: false, files_restored: [], warning: "ignored on failure" }),
		);
		await rewindCommand("cp-fail2", {});
		const out = logged();
		expect(out).toContain("Rewind failed");
		expect(out).not.toContain("Warning:");
	});
});

// ===========================================
// Rewind path — json mode rendering
// ===========================================

describe("rewindCommand — json mode output", () => {
	it("emits the raw result object on success (with warning key present)", async () => {
		mockRewindToCheckpoint.mockReturnValue(
			rewindResult({ files_restored: ["a.ts", "b.ts"], warning: "heads up" }),
		);
		await rewindCommand("cp-json", { json: true });
		const out = loggedJson();
		expect(out.success).toBe(true);
		expect(out.files_restored).toEqual(["a.ts", "b.ts"]);
		expect(out.warning).toBe("heads up");
	});

	it("emits success:false in json on a failed rewind", async () => {
		mockRewindToCheckpoint.mockReturnValue(rewindResult({ success: false, files_restored: [] }));
		await rewindCommand("cp-json-fail", { json: true });
		const out = loggedJson();
		expect(out.success).toBe(false);
		expect(out.files_restored).toEqual([]);
		// warning omitted from the result → absent from the JSON.
		expect(out).not.toHaveProperty("warning");
	});
});

// ===========================================
// Rewind path — error handling (catch)
// ===========================================

describe("rewindCommand — error handling", () => {
	it("reports an Error's message and sets exit code 1 (normal mode)", async () => {
		mockRewindToCheckpoint.mockImplementation(() => {
			throw new Error("checkpoint cp-missing not found");
		});
		await rewindCommand("cp-missing", {});
		expect(errored()).toContain("Error: checkpoint cp-missing not found");
		expect(process.exitCode).toBe(1);
		// Nothing should have been written to stdout on the error path.
		expect(logged()).toBe("");
	});

	it("stringifies a non-Error throw (exercises the String(err) branch)", async () => {
		// A thrown string is not `instanceof Error` → the ternary's else runs.
		mockRewindToCheckpoint.mockImplementation(() => {
			throw "raw failure string";
		});
		await rewindCommand("cp-raw", {});
		expect(errored()).toContain("Error: raw failure string");
		expect(process.exitCode).toBe(1);
	});

	it("emits a structured error object in json mode on throw", async () => {
		mockRewindToCheckpoint.mockImplementation(() => {
			throw new Error("boom");
		});
		await rewindCommand("cp-json-err", { json: true });
		const payload = parseWire(JSON.parse(errored()), wireRecord(wireUnknown), "test JSON value");
		expect(payload.error).toBe("boom");
		expect(process.exitCode).toBe(1);
	});
});
