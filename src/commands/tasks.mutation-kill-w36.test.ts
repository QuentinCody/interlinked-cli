// ===========================================
// interlinked tasks — wave-36 mutation-kill suite
// ===========================================
// Targets specific SURVIVED mutants from .interlinked/mutation-manifest.json
// for src/commands/tasks.ts (pass1_w36). Each test is built to distinguish
// pristine behavior from the exact mutant replacement it targets — see the
// comment above each `it()` naming the mutantId. Mocks the single I/O
// boundary (../lib/api-client.js → getClient) exactly like the companion
// tasks.test.ts, but kept as a standalone file per the mutation-kill fleet
// convention (test-contract markers on every case).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../lib/json-types.js";

const mockGetClient = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: () => mockGetClient(),
}));

process.env.NO_COLOR = "1";

import {
	tasksCreateCommand,
	tasksListCommand,
	tasksShowCommand,
} from "./tasks.js";

// Fixed clock (module-level fake timers, per test_nondeterminism guidance)
// so relativeTime() computations below are deterministic forever, never
// depending on the wall clock at run time.
vi.useFakeTimers();
const FIXED_NOW = "2026-01-02T00:00:00.000Z";
const FIXED_RECENT = "2026-01-01T23:59:55.000Z"; // 5s before FIXED_NOW

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

interface FakeClientOpts {
	authenticated?: boolean;
	localDev?: boolean;
	agentName?: string | undefined;
	callTool?: (name: string, args: JsonObject) => unknown;
}

let lastCall: { name: string; args: JsonObject } | undefined;

function installClient(opts: FakeClientOpts): void {
	lastCall = undefined;
	const callTool = opts.callTool ?? ((_name: string, _args: JsonObject) => ({ tasks: [] }));
	const config: { agent_name?: string } = {};
	if (opts.agentName !== undefined) config.agent_name = opts.agentName;
	mockGetClient.mockReturnValue({
		isAuthenticated: () => opts.authenticated ?? true,
		isLocalDevServer: () => opts.localDev ?? false,
		getConfig: () => config,
		callTool: async (name: string, args: JsonObject) => {
			lastCall = { name, args };
			return callTool(name, args);
		},
	});
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const join = (calls: unknown[][]): string =>
	calls
		.map((call) => call.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
		.join("\n");
const out = (): string => strip(join(logSpy.mock.calls));
const err = (): string => strip(join(errSpy.mock.calls));
const rawOut = (): string => String(logSpy.mock.calls[0]?.[0] ?? "");

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	process.exitCode = undefined;
	vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
	mockGetClient.mockReset();
	vi.clearAllMocks();
});

describe("tasks show: malformed server response", () => {
	it("reports a non-object task response as an error", async () => {
		installClient({ callTool: () => "just-a-string" });
		await tasksShowCommand("1", { json: true });
		expect(rawOut()).toBe("");
		expect(err()).toContain("Invalid task");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// tasksListCommand — arg-mapping conditionals
// mutantIds: f609f55b01be0df3 (opts.status->true),
//            89621439efe9c24a (opts.assignee->true),
//            6219633da3cb5a44 (opts.priority->true)
// ===========================================
describe("tasks list: strict arg-key absence (f609f55b01be0df3, 89621439efe9c24a, 6219633da3cb5a44)", () => {
	// test-contract: boundary — toEqual({}) ignores undefined-valued keys, so
	// this must check own-key presence directly: any of the three mutants
	// forces its key onto `args` with value `undefined`, which Object.keys
	// still reports.
	it("sets no status/assignee/priority keys at all when opts omit them", async () => {
		installClient({ callTool: () => ({ tasks: [] }) });
		await tasksListCommand({ json: true });
		expect(Object.keys(lastCall!.args)).toEqual([]);
	});
});

// ===========================================
// tasksListCommand normal() — array init + header labels + join separators
// ===========================================
describe("tasks list normal: header line + array-init + string fallbacks", () => {
	// test-contract: public-api — the rendered header row must literally carry
	// "Title" (8f80a5a6338b0d45), "Priority" (4fe4b7e8706b37cb), and "Updated"
	// (150e077e96a58eda); each mutant blanks its label to "".
	it("renders Title, Priority, and Updated column headers verbatim", async () => {
		installClient({
			callTool: () => ({
				tasks: [
					{
						id: 1,
						status: "pending",
						title: "T",
						assignee_name: "a",
						priority: "high",
						updated_at: FIXED_RECENT,
					},
				],
			}),
		});
		await tasksListCommand({});
		const text = out();
		const headerLine = text.split("\n").find((l) => l.includes("ID") && l.includes("Status"));
		expect(headerLine).toBeDefined();
		expect(headerLine).toContain("Title");
		expect(headerLine).toContain("Priority");
		expect(headerLine).toContain("Updated");
	});

	// test-contract: invariant — the empty-tasks early return joins with "\n"
	// (3e0406a3c28a51bb); the mutant joins with "" and collapses the header's
	// trailing dash line directly into "No tasks found" with no newline.
	it("keeps the dash separator and 'No tasks found' on distinct lines when empty", async () => {
		installClient({ callTool: () => ({ tasks: [] }) });
		await tasksListCommand({});
		expect(out()).toMatch(/─+\n\s*No tasks found/);
	});

	// test-contract: invariant — the final normal() return also joins with
	// "\n" (f79e247eda88a0b9); the mutant collapses the header's dash line
	// directly into the table's own header row with no newline.
	it("keeps the header's dash line and the table header row on distinct lines", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 1, title: "x" }] }) });
		await tasksListCommand({});
		expect(out()).toMatch(/─+\nID/);
	});

	// test-contract: boundary — id fallback `String(t.id || "")` and title
	// fallback `truncate(t.title || "", 40)` both default to "" (mutantIds
	// b942edefb5b6728f, 01d2047ebaeface2); the mutant injects a literal
	// "Stryker was here!" marker instead of the empty string.
	it("never renders the injected 'Stryker was here' marker for missing id/title", async () => {
		installClient({ callTool: () => ({ tasks: [{ status: "pending" }] }) });
		await tasksListCommand({});
		expect(out()).not.toContain("Stryker was here");
	});

	// A seeded initial array element (5965e8c5caae829f) would surface as a
	// leading line before the header, so pin the first two rendered lines.
	// test-contract: invariant — `const lines: string[] = []` (5965e8c5caae829f)
	it("starts the normal render with the header, not a stray seeded line", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 1, title: "x" }] }) });
		await tasksListCommand({});
		const lines = out().split("\n");
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe("Tasks");
	});

	// test-contract: boundary — `t.updated_at || t.created_at`
	// (f38d29abc22db6c1); the mutant rewrites `||` to `&&`, which returns
	// created_at (undefined here) instead of the present updated_at.
	it("prefers updated_at over created_at when only updated_at is present", async () => {
		installClient({
			callTool: () => ({
				tasks: [{ id: 1, title: "x", updated_at: FIXED_RECENT }],
			}),
		});
		await tasksListCommand({});
		const text = out();
		expect(text).toContain("ago");
		expect(text).not.toContain("never");
	});
});

// ===========================================
// tasksListCommand full() — array init + string fallbacks + join separator
// ===========================================
describe("tasks list full: array-init, blank markers, join separator", () => {
	// test-contract: invariant — `const lines: string[] = []`
	// (67e798e482daf660) and the "" fallbacks for the blank separator /
	// title (88e53adfd261dd75, 4ed3daa76b2a3a7b) all default to "";
	// each mutant would inject a literal "Stryker was here!" marker.
	it("never renders the injected 'Stryker was here' marker in full mode", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 4 }] }) });
		await tasksListCommand({ full: true });
		expect(out()).not.toContain("Stryker was here");
	});

	// The blank-separator element joined on both sides by "\n" produces a
	// double newline right before each record's "#id" line; the mutant
	// joins with "" and collapses that gap entirely.
	// test-contract: invariant — final full() join with "\n" (a260d4123f9d6134)
	it("keeps a blank line (double newline) between the header and the first record", async () => {
		const now = "2026-01-01T00:00:00.000Z";
		installClient({
			callTool: () => ({
				tasks: [
					{
						id: 3,
						status: "in_progress",
						title: "Build",
						assignee_name: "bob",
						priority: "low",
						created_at: now,
						updated_at: now,
					},
				],
			}),
		});
		await tasksListCommand({ full: true });
		const lines = out().split("\n");
		const idx = lines.findIndex((l) => l.includes("#3"));
		expect(idx).toBeGreaterThan(0);
		expect(lines[idx - 1]).toBe("");
	});
});

// ===========================================
// tasksCreateCommand — arg-mapping conditionals
// mutantIds: 7057700e3b856bbc (opts.description->true),
//            8d6d1a91f1389b4d (opts.assignee->true),
//            f3962f1538777595 (opts.priority->true)
// ===========================================
describe("tasks create: strict arg-key absence (7057700e3b856bbc, 8d6d1a91f1389b4d, f3962f1538777595)", () => {
	// test-contract: boundary — same toEqual-ignores-undefined trap as list;
	// any of the three mutants forces its key onto args with value undefined.
	it("sets only title and creator_name when no optional opts are given", async () => {
		installClient({ agentName: "a", callTool: () => ({ task: { id: 1 } }) });
		await tasksCreateCommand("T", { json: true });
		expect(Object.keys(lastCall!.args).sort()).toEqual(["creator_name", "title"]);
	});
});

// ===========================================
// tasksShowCommand — array init + labels + fallback string + description gate
// ===========================================
describe("tasks show: array-init, labels, fallbacks, description gate", () => {
	// test-contract: invariant — `const lines: string[] = []`
	// (1d1609a00500c3c6); the mutant seeds it with a "Stryker was here"
	// marker element.
	it("never renders the injected 'Stryker was here' marker", async () => {
		installClient({ callTool: () => ({}) });
		await tasksShowCommand("9", {});
		expect(out()).not.toContain("Stryker was here");
	});

	// test-contract: public-api — labels "Title" (cc9c1f0ebcde7857),
	// "Status" (2a75570f1a8f0fc8), "Priority" (2c57f82f3117ffa8), and
	// "Assignee" (285a5b2f70725f1a) must render verbatim; each mutant
	// blanks its label to "".
	it("renders Title, Status, Priority, and Assignee labels verbatim", async () => {
		installClient({
			callTool: () => ({
				id: 11,
				title: "Full task",
				status: "blocked",
				priority: "high",
				assignee_name: "dave",
			}),
		});
		await tasksShowCommand("11", {});
		const text = out();
		expect(text).toContain("Title");
		expect(text).toContain("Status");
		expect(text).toContain("Priority");
		expect(text).toContain("Assignee");
	});

	// test-contract: boundary — `result?.title || ""` fallback
	// (f7ccf6a15a155fb1) defaults to ""; the mutant injects
	// "Stryker was here!" when title is absent.
	it("falls back to an empty title without injecting a marker", async () => {
		installClient({ callTool: () => ({ id: 9 }) });
		await tasksShowCommand("9", {});
		expect(out()).not.toContain("Stryker was here");
	});

	// test-contract: invariant — `if (result?.description)` (e8863b3c2fedbb71);
	// the mutant replaces the whole guard with `true`, so a missing
	// description still gets pushed as `\nundefined`.
	it("omits the description block entirely (no literal 'undefined') when absent", async () => {
		installClient({ callTool: () => ({ id: 9, title: "x" }) });
		await tasksShowCommand("9", {});
		expect(out()).not.toContain("undefined");
	});

	// The description push template's own leading "\n" combined with the
	// array's `lines.join("\n")` means a present description is preceded by
	// a blank line; the mutant strips that leading "\n" from the template.
	// test-contract: invariant — description template leading newline (ba6e967766e3f090)
	it("keeps a blank line (double newline) before a present description", async () => {
		installClient({ callTool: () => ({ id: 9, title: "x", description: "DESCTEXT123" }) });
		await tasksShowCommand("9", {});
		const lines = out().split("\n");
		const idx = lines.findIndex((l) => l === "DESCTEXT123");
		expect(idx).toBeGreaterThan(0);
		expect(lines[idx - 1]).toBe("");
	});
});
