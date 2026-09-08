// ===========================================
// interlinked inbox — behavioral coverage
// ===========================================
// Mocks the single I/O boundary (../lib/api-client.js → getClient) and runs the
// REAL output.js / formatter.js so assertions land on the actual rendered
// strings, JSON payloads, and side-effects (process.exitCode). The fake client
// is reconfigured per-test to flip each branch.
//
// Branch map covered:
//   - auth gate: unauthenticated + non-local-dev (early return) vs
//     authenticated, vs local-dev-server (token absent but local)
//   - agent name resolution: opts.agent?.trim() || configured; configured
//     undefined; whitespace-only config (?.trim() → "") → throw
//   - unread_only: !opts.all (default true / --all false), reflected in args +
//     header text ("Unread Messages" vs "All Messages")
//   - --limit: valid int passed through; NaN ("abc") throw; "0" throw; absent
//   - result shape precedence: result.messages, result.inbox, [] (null result)
//   - output modes: json (payload shape), short (empty "No messages" + plural),
//     normal (empty dim line; populated table with urgent/normal/missing
//     importance + from||from_agent||"-"), full (urgent tag; sender fallback;
//     recipients||to_agents||[]; body_md fallback)
//   - catch: Error message vs non-Error (string reject) — both via Server error.
//
// NO_COLOR disables ANSI so the real formatter's output is plain text and the
// matchers stay exact without a strip() pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../lib/json-types.js";

// ---- single I/O boundary mock --------------------------------------------
const mockGetClient = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: () => mockGetClient(),
}));

// Best-effort: ask the real formatter for plain text. formatter.ts captures
// supportsColor at module-load (before this top-level statement runs under ESM
// hoisting), so we ALSO strip ANSI in the assertion helpers below — that makes
// the matchers hermetic regardless of how the runner is invoked (TTY vs piped).
process.env.NO_COLOR = "1";

import { inboxCommand } from "./inbox.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

// ---- fake client builder --------------------------------------------------
interface FakeClientOpts {
	authenticated?: boolean;
	localDev?: boolean;
	agentName?: string | undefined;
	callTool?: (name: string, args: JsonObject) => unknown;
}

let lastCall: { name: string; args: JsonObject } | undefined;

function installClient(opts: FakeClientOpts): void {
	lastCall = undefined;
	const callTool =
		opts.callTool ??
		((_name: string, _args: JsonObject) => ({ messages: [] }));
	mockGetClient.mockReturnValue({
		isAuthenticated: () => opts.authenticated ?? true,
		isLocalDevServer: () => opts.localDev ?? false,
		getConfig: () => ({ agent_name: opts.agentName }),
		callTool: async (name: string, args: JsonObject) => {
			lastCall = { name, args };
			return callTool(name, args);
		},
	});
}

// ---- console / exit capture ----------------------------------------------
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const join = (calls: unknown[][]): string =>
	calls.map((call) => call.map((a) => (typeof a === "string" ? a : String(a))).join(" ")).join("\n");
const out = (): string => strip(join(logSpy.mock.calls));
const err = (): string => strip(join(errSpy.mock.calls));
// Unstripped first console.log payload — used where the output is pure JSON
// (json mode never colorizes) so JSON.parse sees the raw text.
const rawOut = (): string => String(logSpy.mock.calls[0]?.[0] ?? "");

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
	mockGetClient.mockReset();
	vi.useRealTimers();
});

// ===========================================
// Auth gate
// ===========================================
describe("inbox: auth gate", () => {
	it("returns early with an error when unauthenticated and not local-dev", async () => {
		installClient({ authenticated: false, localDev: false });
		await inboxCommand({});
		expect(err()).toBe("Error: Not authenticated. Run: interlinked login");
		expect(out()).toBe("");
		expect(process.exitCode).toBe(1);
		// No tool call attempted.
		expect(lastCall).toBeUndefined();
	});

	it("emits a structured JSON error when unauthenticated in --json mode", async () => {
		installClient({ authenticated: false, localDev: false });
		await inboxCommand({ json: true });
		expect(JSON.parse(err())).toEqual({
			error: "Not authenticated. Run: interlinked login",
			details: undefined,
		});
		expect(process.exitCode).toBe(1);
	});

	it("proceeds when not authenticated but pointed at a local dev server", async () => {
		installClient({
			authenticated: false,
			localDev: true,
			agentName: "alice",
			callTool: () => ({ messages: [] }),
		});
		await inboxCommand({});
		// Got past the gate: a fetch happened, "Unread Messages" rendered.
		expect(lastCall?.name).toBe("fetch_inbox");
		expect(out()).toContain("Unread Messages");
	});
});

// ===========================================
// Agent name resolution
// ===========================================
describe("inbox: agent name resolution", () => {
	it("prefers the trimmed --agent flag over configured agent_name", async () => {
		installClient({ agentName: "configured", callTool: () => ({ messages: [] }) });
		await inboxCommand({ agent: "  flagAgent  " });
		expect(lastCall?.args.agent_name).toBe("flagAgent");
	});

	it("falls back to the configured agent_name when no --agent is given", async () => {
		installClient({ agentName: "configuredAgent", callTool: () => ({ messages: [] }) });
		await inboxCommand({});
		expect(lastCall?.args.agent_name).toBe("configuredAgent");
	});

	it("throws (caught as Server error) when neither --agent nor agent_name is set", async () => {
		installClient({ agentName: undefined });
		await inboxCommand({});
		expect(err()).toContain(
			"Server error: agent_name is required. Set it with 'interlinked enable --agent <name>' or pass --agent.",
		);
		expect(process.exitCode).toBe(1);
		expect(lastCall).toBeUndefined(); // never reached callTool
	});

	it("treats a whitespace-only configured agent_name as missing", async () => {
		installClient({ agentName: "   " });
		await inboxCommand({});
		expect(err()).toContain("Server error: agent_name is required.");
		expect(lastCall).toBeUndefined();
	});
});

// ===========================================
// Request args: unread_only + limit
// ===========================================
describe("inbox: request args", () => {
	it("requests unread_only=true by default", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: [] }) });
		await inboxCommand({});
		expect(lastCall?.args).toMatchObject({ agent_name: "a", unread_only: true });
		expect(lastCall?.args).not.toHaveProperty("limit");
	});

	it("requests unread_only=false with --all", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: [] }) });
		await inboxCommand({ all: true });
		expect(lastCall?.args.unread_only).toBe(false);
	});

	it("passes a parsed positive --limit through to the tool call", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: [] }) });
		await inboxCommand({ limit: "5" });
		expect(lastCall?.args.limit).toBe(5);
	});

	it("rejects a non-numeric --limit", async () => {
		installClient({ agentName: "a" });
		await inboxCommand({ limit: "abc" });
		expect(err()).toContain("Server error: Invalid --limit value: abc");
		expect(process.exitCode).toBe(1);
		expect(lastCall).toBeUndefined();
	});

	it("rejects a zero --limit (<= 0 guard)", async () => {
		installClient({ agentName: "a" });
		await inboxCommand({ limit: "0" });
		expect(err()).toContain("Server error: Invalid --limit value: 0");
		expect(lastCall).toBeUndefined();
	});
});

// ===========================================
// Result-shape precedence
// ===========================================
describe("inbox: result shape precedence", () => {
	const oneMsg = [{ from: "x", body_md: "hi" }];

	it("uses result.messages when present", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: oneMsg }) });
		await inboxCommand({ short: true });
		expect(out()).toBe("1 message(s)");
	});

	it("falls back to result.inbox when messages is absent", async () => {
		installClient({ agentName: "a", callTool: () => ({ inbox: oneMsg }) });
		await inboxCommand({ short: true });
		expect(out()).toBe("1 message(s)");
	});

	it("falls back to [] when the tool returns null", async () => {
		installClient({ agentName: "a", callTool: () => null });
		await inboxCommand({ short: true });
		expect(out()).toBe("No messages");
	});
});

// ===========================================
// Output mode: json
// ===========================================
describe("inbox: json output", () => {
	it("prints the messages array wrapped under a messages key", async () => {
		const msgs = [{ id: 1, from: "bob", body_md: "yo" }];
		installClient({ agentName: "a", callTool: () => ({ messages: msgs }) });
		await inboxCommand({ json: true });
		expect(JSON.parse(rawOut())).toEqual({ messages: msgs });
	});

	it("prints an empty array under json mode when there are no messages", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: [] }) });
		await inboxCommand({ json: true });
		expect(JSON.parse(rawOut())).toEqual({ messages: [] });
	});
});

// ===========================================
// Output mode: short
// ===========================================
describe("inbox: short output", () => {
	it("says 'No messages' when empty", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: [] }) });
		await inboxCommand({ short: true });
		expect(out()).toBe("No messages");
	});

	it("pluralizes the count when populated", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ from: "a" }, { from: "b" }] }),
		});
		await inboxCommand({ short: true });
		expect(out()).toBe("2 message(s)");
	});
});

// ===========================================
// Output mode: normal (default table)
// ===========================================
describe("inbox: normal output", () => {
	it("renders the unread header + dim 'No messages' line when empty", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: [] }) });
		await inboxCommand({});
		const text = out();
		expect(text).toContain("Unread Messages");
		expect(text).toContain("No messages");
	});

	it("renders the 'All Messages' header under --all when empty", async () => {
		installClient({ agentName: "a", callTool: () => ({ messages: [] }) });
		await inboxCommand({ all: true });
		expect(out()).toContain("All Messages");
	});

	it("renders a table with URGENT for urgent importance and the sender", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({
				messages: [
					{
						from: "alice",
						importance: "urgent",
						body_md: "deploy now",
						created_at: new Date().toISOString(),
					},
				],
			}),
		});
		await inboxCommand({});
		const text = out();
		expect(text).toContain("From");
		expect(text).toContain("Priority");
		expect(text).toContain("alice");
		expect(text).toContain("URGENT");
		expect(text).toContain("deploy now");
	});

	it("uses from_agent when from is absent and shows the default 'normal' priority", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({
				messages: [{ from_agent: "legacyBot", body_md: "hello" }],
			}),
		});
		await inboxCommand({});
		const text = out();
		expect(text).toContain("legacyBot");
		expect(text).toContain("normal"); // importance ?? "normal" fallback
	});

	it("renders a '-' sender and 'normal' priority when both from fields and importance are missing", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ body_md: "anon msg" }] }),
		});
		await inboxCommand({});
		const text = out();
		expect(text).toContain("anon msg");
		expect(text).toContain("-"); // c.dim("-") sender fallback
		expect(text).toContain("normal");
	});

	it("renders a row with an empty message cell when body_md is missing (|| '' fallback)", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ from: "noBody" }] }),
		});
		await inboxCommand({});
		const text = out();
		// Sender still rendered; the Message column is the empty-string fallback,
		// so the body text simply isn't present anywhere in the table.
		expect(text).toContain("noBody");
		expect(text).not.toContain("undefined");
	});

	it("shows an explicit non-urgent importance verbatim", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ from: "x", importance: "low", body_md: "b" }] }),
		});
		await inboxCommand({});
		expect(out()).toContain("low");
	});
});

// ===========================================
// Output mode: full
// ===========================================
describe("inbox: full output", () => {
	it("renders sender → recipients, the URGENT tag, and the body", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({
				messages: [
					{
						from: "alice",
						recipients: ["bob", "carol"],
						importance: "urgent",
						body_md: "ship it",
						created_at: new Date().toISOString(),
					},
				],
			}),
		});
		await inboxCommand({ full: true });
		const text = out();
		expect(text).toContain("alice → bob, carol");
		expect(text).toContain("[URGENT]");
		expect(text).toContain("ship it");
	});

	it("uses 'unknown' sender, to_agents recipients, and empty body fallback when fields are missing", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ to_agents: ["team"] }] }),
		});
		await inboxCommand({ full: true });
		const text = out();
		expect(text).toContain("unknown → team");
		// non-urgent → no [URGENT] tag
		expect(text).not.toContain("[URGENT]");
	});

	it("renders an empty recipient list when neither recipients nor to_agents is set", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ from: "solo", body_md: "x" }] }),
		});
		await inboxCommand({ full: true });
		// "solo → " with nothing after the arrow (join of []).
		expect(out()).toMatch(/solo → /);
	});

	it("renders the 'All Messages' header in full mode under --all", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ from: "a", body_md: "b" }] }),
		});
		await inboxCommand({ all: true, full: true });
		expect(out()).toContain("All Messages");
	});

	it("uses from_agent as the sender in full mode when from is absent", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ messages: [{ from_agent: "legacy", body_md: "z" }] }),
		});
		await inboxCommand({ full: true });
		expect(out()).toContain("legacy →");
	});
});

// ===========================================
// catch / error path
// ===========================================
describe("inbox: server error handling", () => {
	it("reports an Error's message with the reachability hint (normal mode)", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw new Error("connection refused");
			},
		});
		await inboxCommand({});
		expect(err()).toBe("Error: Server error: connection refused");
		expect(process.exitCode).toBe(1);
	});

	it("includes the hint in --full mode and stringifies a non-Error reject", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw "string failure";
			},
		});
		await inboxCommand({ full: true });
		const text = err();
		expect(text).toContain("Server error: string failure");
		expect(text).toContain("Is the Server reachable?");
		expect(process.exitCode).toBe(1);
	});

	it("emits a structured JSON error with details in --json mode", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw new Error("boom");
			},
		});
		await inboxCommand({ json: true });
		const parsed = JSON.parse(err());
		expect(parsed.error).toBe("Server error: boom");
		expect(parsed.details).toEqual({ hint: "Is the Server reachable?" });
		expect(process.exitCode).toBe(1);
	});
});
