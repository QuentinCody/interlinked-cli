// ===========================================
// interlinked cloud — behavioral coverage
// ===========================================
// Deep behavioral tests for the cloud-governor inspector. Every module
// boundary that touches fs / network / process is mocked so each branch is
// driven deterministically with no real I/O:
//   - node:fs (existsSync/readFileSync) for loadCloudUrl
//   - ../lib/auth (resolveAuthToken) for the token gate
//   - global fetch for fetchRecent (ok / non-ok / 401 / network throw)
//   - process.exit (throws so control flow halts like the real `never`)
//   - process.stdout/stderr.write (the command emits via streams, not console)
// We assert real emitted strings, exit codes, the derived URL + headers
// passed to fetch, and the json vs human render paths. The pure helpers
// (loadCloudUrl / deriveAdminUrl / formatRecentEvents) are re-covered here so
// this file reaches the whole module standalone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";

// ---- ../lib/auth mock: scripted token resolution ----------------------
const mockResolveAuthToken = vi.fn<(cwd?: string) => string | null>();
vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: (cwd?: string) => mockResolveAuthToken(cwd),
}));

// ---- node:fs mock: virtual config.local.json --------------------------
// fsExists controls existsSync; fsFiles maps path -> contents for
// readFileSync; fsReadThrows makes readFileSync throw (parse/IO failure).
let fsExists: Set<string>;
let fsFiles: Record<string, string>;
let fsReadThrows: Set<string>;

vi.mock("node:fs", () => ({
	existsSync: (p: string) => fsExists.has(p),
	readFileSync: (p: string) => {
		if (fsReadThrows.has(p)) throw new Error(`EACCES ${p}`);
		if (!(p in fsFiles)) throw new Error(`ENOENT ${p}`);
		return fsFiles[p];
	},
}));

import {
	type CloudRecentOpts,
	cloudRecentCommand,
	deriveAdminUrl,
	formatRecentEvents,
	loadCloudUrl,
	parseCloudGovernorUrl,
} from "./cloud.js";

// --- process.exit + stream capture -------------------------------------

class ProcessExit extends Error {
	constructor(public code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function stdout(): string {
	return (outSpy.mock.calls).map((a: unknown[]) => String(a[0])).join("");
}
function stderr(): string {
	return (errSpy.mock.calls).map((a: unknown[]) => String(a[0])).join("");
}

const CWD = "/proj";
const CONFIG_PATH = "/proj/.interlinked/config.local.json";

/** Mark config.local.json present with a cloud_governor.url. */
function withCloudUrl(url: string): void {
	fsExists.add(CONFIG_PATH);
	fsFiles[CONFIG_PATH] = JSON.stringify({ cloud_governor: { enabled: true, url } });
}

function opts(over: Partial<CloudRecentOpts> = {}): CloudRecentOpts {
	return { cwd: CWD, limit: 20, ...over };
}

function res(over: { status?: number; statusText?: string; jsonValue?: unknown }): Response {
	return new Response(JSON.stringify(over.jsonValue) ?? null, {
		status: over.status ?? 200, statusText: over.statusText ?? "OK",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	fsExists = new Set();
	fsFiles = {};
	fsReadThrows = new Set();
	mockResolveAuthToken.mockReturnValue("tok-123");
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ProcessExit(code === undefined ? undefined : Number(code));
	});
	outSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true));
	errSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true));
});

afterEach(() => {
	exitSpy.mockRestore();
	outSpy.mockRestore();
	errSpy.mockRestore();
	vi.unstubAllGlobals();
});

// =======================================================================
// parseCloudGovernorUrl — the boundary parser loadCloudUrl delegates to
// =======================================================================

describe("parseCloudGovernorUrl", () => {
	it("P1: returns the url when cloud_governor.url is a non-empty string", () => {
		expect(parseCloudGovernorUrl({ cloud_governor: { url: "https://x/governor/evaluate" } })).toBe(
			"https://x/governor/evaluate",
		);
	});

	it("P2: ignores unrelated sibling fields on both the root and the block", () => {
		expect(
			parseCloudGovernorUrl({
				agent_name: "qcody",
				cloud_governor: { enabled: true, timeout_ms: 3000, url: "https://x/governor/evaluate" },
			}),
		).toBe("https://x/governor/evaluate");
	});

	it("N1: returns null for a non-object root value (array)", () => {
		expect(parseCloudGovernorUrl(["not", "an", "object"])).toBeNull();
	});

	it("N2: returns null for a non-object root value (string)", () => {
		expect(parseCloudGovernorUrl("nope")).toBeNull();
	});

	it("N3: returns null for a null root value", () => {
		expect(parseCloudGovernorUrl(null)).toBeNull();
	});

	it("N4: returns null when cloud_governor is missing entirely", () => {
		expect(parseCloudGovernorUrl({ agent_name: "x" })).toBeNull();
	});

	it("N5: returns null when cloud_governor is a non-object (string)", () => {
		expect(parseCloudGovernorUrl({ cloud_governor: "nope" })).toBeNull();
	});

	it("N6: returns null when cloud_governor is a non-object (array) -- isJsonObject rejects arrays", () => {
		expect(parseCloudGovernorUrl({ cloud_governor: ["nope"] })).toBeNull();
	});

	it("N7: returns null when cloud_governor is null", () => {
		expect(parseCloudGovernorUrl({ cloud_governor: null })).toBeNull();
	});

	it("N8: returns null when url is present but not a string", () => {
		expect(parseCloudGovernorUrl({ cloud_governor: { url: 42 } })).toBeNull();
	});

	it("N9: returns null when url is an empty string", () => {
		expect(parseCloudGovernorUrl({ cloud_governor: { url: "" } })).toBeNull();
	});

	it("N10: returns null when url is missing", () => {
		expect(parseCloudGovernorUrl({ cloud_governor: { enabled: true } })).toBeNull();
	});
});

// =======================================================================
// loadCloudUrl
// =======================================================================

describe("loadCloudUrl", () => {
	it("returns null when config.local.json is missing", () => {
		expect(loadCloudUrl(CWD)).toBeNull();
	});

	it("returns null when readFileSync throws (unparseable / IO error)", () => {
		fsExists.add(CONFIG_PATH);
		fsReadThrows.add(CONFIG_PATH);
		expect(loadCloudUrl(CWD)).toBeNull();
	});

	it("returns null when JSON parses but has no cloud_governor block", () => {
		fsExists.add(CONFIG_PATH);
		fsFiles[CONFIG_PATH] = JSON.stringify({ agent_name: "x" });
		expect(loadCloudUrl(CWD)).toBeNull();
	});

	it("returns null when cloud_governor is a non-object (e.g. a string)", () => {
		fsExists.add(CONFIG_PATH);
		fsFiles[CONFIG_PATH] = JSON.stringify({ cloud_governor: "nope" });
		expect(loadCloudUrl(CWD)).toBeNull();
	});

	it("returns null when cloud_governor is null", () => {
		fsExists.add(CONFIG_PATH);
		fsFiles[CONFIG_PATH] = JSON.stringify({ cloud_governor: null });
		expect(loadCloudUrl(CWD)).toBeNull();
	});

	it("returns null when url is present but not a string", () => {
		fsExists.add(CONFIG_PATH);
		fsFiles[CONFIG_PATH] = JSON.stringify({ cloud_governor: { url: 42 } });
		expect(loadCloudUrl(CWD)).toBeNull();
	});

	it("returns null when url is an empty string", () => {
		fsExists.add(CONFIG_PATH);
		fsFiles[CONFIG_PATH] = JSON.stringify({ cloud_governor: { url: "" } });
		expect(loadCloudUrl(CWD)).toBeNull();
	});

	it("returns the url string when present and non-empty", () => {
		withCloudUrl("https://cg.example.workers.dev/governor/evaluate");
		expect(loadCloudUrl(CWD)).toBe("https://cg.example.workers.dev/governor/evaluate");
	});
});

// =======================================================================
// deriveAdminUrl
// =======================================================================

describe("deriveAdminUrl", () => {
	it("derives /admin/recent from the evaluate URL, preserving origin+port", () => {
		expect(deriveAdminUrl("http://localhost:8787/governor/evaluate", 20)).toBe(
			"http://localhost:8787/admin/recent?limit=20",
		);
	});

	it("ignores any path/query on the source URL (resolves against origin)", () => {
		expect(deriveAdminUrl("https://x.workers.dev/anything?foo=bar", 100)).toBe(
			"https://x.workers.dev/admin/recent?limit=100",
		);
	});
});

// =======================================================================
// formatRecentEvents (pure render — every branch)
// =======================================================================

describe("formatRecentEvents", () => {
	it("renders an empty-state line when there are no events", () => {
		expect(formatRecentEvents([]).toLowerCase()).toContain("no events");
	});

	it("decorates a block decision and shortens long session ids to 8 chars", () => {
		const out = formatRecentEvents([
			{
				id: 287,
				session_id: "cli-test-session-long",
				tool_name: "Bash",
				decision: "block",
				rule_id: "cloud-builtin-cf-dns-record-delete",
				created_at: 1779991638099,
			},
		]);
		expect(out).toContain("287");
		expect(out).toContain("Bash");
		expect(out).toContain("block");
		expect(out).toContain("cloud-builtin-cf-dns-record-delete");
		// session truncated to first 8 chars, longer remainder dropped
		expect(out).toContain("cli-test");
		expect(out).not.toContain("cli-test-session-long");
	});

	it("decorates an allow decision and renders an em-dash for a null rule_id", () => {
		const out = formatRecentEvents([
			{ id: 1, session_id: "abc", tool_name: "Edit", decision: "allow", rule_id: null, created_at: 1779991638099 },
		]);
		expect(out).toContain("allow");
		expect(out).toContain("—");
	});

	it("renders ? fallbacks for missing id/session/tool/decision and missing created_at", () => {
		const out = formatRecentEvents([{}]);
		// id?->?, session undefined->?, tool undefined->?, created_at undefined->?
		expect(out).toContain("?");
	});

	it("passes through an unknown decision verbatim (neither block nor allow)", () => {
		const out = formatRecentEvents([{ id: 9, tool_name: "Read", decision: "ask", created_at: 1779991638099 }]);
		expect(out).toContain("ask");
	});
});

// =======================================================================
// cloudRecentCommand — full handler, every branch
// =======================================================================

describe("cloudRecentCommand", () => {
	it("exits 2 with a config hint when no cloud_governor.url is configured", async () => {
		await expect(cloudRecentCommand(opts())).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(stderr()).toContain("no cloud_governor.url");
		expect(stderr()).toContain("governor/evaluate");
		expect(mockResolveAuthToken).not.toHaveBeenCalled();
	});

	it("exits 2 with a login hint when configured but not authenticated", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		mockResolveAuthToken.mockReturnValue(null);
		await expect(cloudRecentCommand(opts())).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(stderr()).toContain("not authenticated");
		expect(mockResolveAuthToken).toHaveBeenCalledWith(CWD);
	});

	it("fetches /admin/recent with a bearer token and renders the human table", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
			res({
				jsonValue: {
					workspace_id: "ws-7",
					count: 1,
					events: [{ id: 5, tool_name: "Bash", decision: "block", rule_id: "r1", created_at: 1779991638099 }],
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await cloudRecentCommand(opts({ limit: 7 }));

		// URL + auth header derived correctly
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = nonNull(fetchMock.mock.calls[0]);
		expect(calledUrl).toBe("https://cg.example/admin/recent?limit=7");
		expect(init).toHaveProperty(["headers","authorization"], "Bearer tok-123");
		expect(init.signal).toBeInstanceOf(AbortSignal);

		const out = stdout();
		expect(out).toContain("Cloud governor — recent events");
		expect(out).toContain("workspace: ws-7");
		expect(out).toContain("1 shown");
		expect(out).toContain("Bash");
		expect(out).toContain("block");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("renders ? workspace and the empty-state when the body omits workspace_id and events", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		vi.stubGlobal("fetch", vi.fn(async () => res({ jsonValue: {} })));

		await cloudRecentCommand(opts());

		const out = stdout();
		expect(out).toContain("workspace: ?");
		expect(out).toContain("0 shown");
		expect(out.toLowerCase()).toContain("no events");
	});

	it("emits raw JSON (pretty-printed) and skips the table when --json is set", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		const body = { workspace_id: "ws-9", count: 0, events: [] };
		vi.stubGlobal("fetch", vi.fn(async () => res({ jsonValue: body })));

		await cloudRecentCommand(opts({ json: true }));

		const out = stdout();
		expect(out).toBe(`${JSON.stringify(body, null, 2)}\n`);
		expect(out).not.toContain("Cloud governor — recent events");
	});

	it("exits 1 when fetch throws (governor unreachable), surfacing the error message", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);

		await expect(cloudRecentCommand(opts())).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		const e = stderr();
		expect(e).toContain("could not reach cloud governor");
		expect(e).toContain("https://cg.example/admin/recent?limit=20");
		expect(e).toContain("ECONNREFUSED");
	});

	it("stringifies a non-Error fetch rejection in the unreachable message", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw "boom-string";
			}),
		);

		await expect(cloudRecentCommand(opts())).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stderr()).toContain("boom-string");
	});

	it("exits 1 with a token-expired hint on a 401 response", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => res({ status: 401, statusText: "Unauthorized" })),
		);

		await expect(cloudRecentCommand(opts())).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		const e = stderr();
		expect(e).toContain("cloud governor returned 401 Unauthorized");
		expect(e).toContain("token expired");
		expect(e).toContain("interlinked login");
	});

	it("exits 1 on a non-401 error response with no token hint", async () => {
		withCloudUrl("https://cg.example/governor/evaluate");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => res({ status: 500, statusText: "Internal Server Error" })),
		);

		await expect(cloudRecentCommand(opts())).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		const e = stderr();
		expect(e).toContain("cloud governor returned 500 Internal Server Error");
		expect(e).not.toContain("token expired");
	});
});
