// ===========================================
// interlinked handoff — behavioral coverage
// ===========================================
// Mocks the single I/O boundary (../lib/api-client.js → getClient) and runs the
// REAL output.js / formatter.js so assertions land on the actual rendered
// strings, JSON payloads, and side-effects (process.exitCode). The fake client
// is reconfigured per-test to flip each branch.
//
// Branch map covered (handoff.ts):
//   - auth gate (line 22): unauthenticated + non-local-dev (early return) vs
//     authenticated, vs local-dev-server (token absent but local).
//   - get_work_context try/catch (lines 30-36): resolves (context set) vs
//     rejects (caught, handoff continues with context = null).
//   - contextSummary (line 39): context present → JSON.stringify(...).slice(0,500)
//     including the >500-char truncation boundary; context null → literal
//     "No context available".
//   - handoffResult.context_available (line 61): !!context true / false.
//   - send_message args: to:[toAgent], importance:"urgent", body_md content.
//   - output modes: json (full result payload), normal (header + kv lines with
//     the context "included"/"unavailable" branch), short + full (no dedicated
//     renderer → fall through to normal()).
//   - outer catch (lines 79-81): send_message throws → "Handoff failed: ..."
//     via Error.message vs String(err) for a non-Error reject.
//
// NO_COLOR best-effort + an explicit ANSI strip keep the matchers hermetic
// regardless of TTY-vs-piped invocation (formatter.ts samples color support at
// module load, before this top-level statement runs under ESM hoisting).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../lib/json-types.js";

// ---- single I/O boundary mock --------------------------------------------
const mockGetClient = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: () => mockGetClient(),
}));

process.env.NO_COLOR = "1";

import { handoffCommand } from "./handoff.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

// ---- fake client builder --------------------------------------------------
interface FakeClientOpts {
	authenticated?: boolean;
	localDev?: boolean;
	// Per-tool behavior. Return a value to resolve; throw to reject.
	callTool?: (name: string, args: JsonObject) => unknown;
}

interface RecordedCall {
	name: string;
	args: JsonObject;
}

let calls: RecordedCall[] = [];

function installClient(opts: FakeClientOpts): void {
	calls = [];
	const behavior =
		opts.callTool ?? ((_name: string, _args: JsonObject): unknown => ({ ok: true }));
	mockGetClient.mockReturnValue({
		isAuthenticated: () => opts.authenticated ?? true,
		isLocalDevServer: () => opts.localDev ?? false,
		callTool: async (name: string, args: JsonObject): Promise<unknown> => {
			calls.push({ name, args });
			return behavior(name, args);
		},
	});
}

/** The recorded call for a given tool name, or undefined if it never ran. */
const callTo = (name: string): RecordedCall | undefined => calls.find((c) => c.name === name);

// ---- console / exit capture ----------------------------------------------
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const join = (rows: unknown[][]): string =>
	rows
		.map((row) => row.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
		.join("\n");
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
});

// ===========================================
// Auth gate
// ===========================================
describe("handoff: auth gate", () => {
	it("returns early with an error when unauthenticated and not local-dev", async () => {
		installClient({ authenticated: false, localDev: false });
		await handoffCommand("alpha", "bravo", {});
		expect(err()).toBe("Error: Not authenticated. Run: interlinked login");
		expect(out()).toBe("");
		expect(process.exitCode).toBe(1);
		// Gate fired before any tool call.
		expect(calls).toHaveLength(0);
	});

	it("emits a structured JSON error when unauthenticated in --json mode", async () => {
		installClient({ authenticated: false, localDev: false });
		await handoffCommand("alpha", "bravo", { json: true });
		expect(JSON.parse(err())).toEqual({
			error: "Not authenticated. Run: interlinked login",
			details: undefined,
		});
		expect(out()).toBe("");
		expect(process.exitCode).toBe(1);
		expect(calls).toHaveLength(0);
	});

	it("proceeds when not authenticated but pointed at a local dev server", async () => {
		installClient({
			authenticated: false,
			localDev: true,
			callTool: () => ({ summary: "ctx" }),
		});
		await handoffCommand("alpha", "bravo", { json: true });
		// Got past the gate: both orchestration steps ran.
		expect(callTo("get_work_context")).toBeDefined();
		expect(callTo("send_message")).toBeDefined();
		expect(process.exitCode).toBeUndefined();
	});

	it("proceeds when authenticated even if not local-dev (no opts object)", async () => {
		installClient({ authenticated: true, localDev: false, callTool: () => ({ k: "v" }) });
		// opts omitted entirely → exercises the `opts || {}` default.
		await handoffCommand("alpha", "bravo");
		expect(callTo("get_work_context")).toBeDefined();
		expect(callTo("send_message")).toBeDefined();
	});
});

// ===========================================
// Orchestration: get_work_context + send_message wiring
// ===========================================
describe("handoff: orchestration", () => {
	it("fetches work context for the source agent, then sends to the target", async () => {
		installClient({ callTool: () => ({ tasks: ["t1"] }) });
		await handoffCommand("source-agent", "target-agent", { json: true });

		const ctx = callTo("get_work_context");
		const msg = callTo("send_message");
		expect(ctx?.args).toMatchObject({ agent_name: "source-agent" });
		expect(msg?.args.to).toEqual(["target-agent"]);
		expect(msg?.args.importance).toBe("urgent");
		// Ordering: context fetch precedes the message send.
		expect(calls.map((c) => c.name)).toEqual(["get_work_context", "send_message"]);
	});

	it("embeds the source agent name and a context summary in the handoff body", async () => {
		installClient({ callTool: () => ({ branch: "feature-x", pending: 3 }) });
		await handoffCommand("worker-1", "worker-2", { json: true });

		const body = callTo("send_message")?.args.body_md;
		expect(typeof body).toBe("string");
		const text = String(body);
		expect(text).toContain("## Handoff from worker-1");
		expect(text).toContain("Agent worker-1 is handing off work to you.");
		expect(text).toContain("### Context");
		// The serialized context is inlined under the Context heading.
		expect(text).toContain('"branch":"feature-x"');
		expect(text).toContain('"pending":3');
	});

	it("truncates a large context summary to 500 characters in the body", async () => {
		// A value whose JSON serialization far exceeds the 500-char slice.
		const big = "z".repeat(5000);
		installClient({ callTool: () => ({ blob: big }) });
		await handoffCommand("a", "b", { json: true });

		const text = String(callTo("send_message")?.args.body_md);
		// Body = fixed prefix lines + the 500-char summary slice. The summary
		// portion must be capped at exactly 500 chars: the prefix ends with the
		// "### Context\n" line, everything after is the slice.
		const marker = "### Context\n";
		const idx = text.indexOf(marker);
		expect(idx).toBeGreaterThanOrEqual(0);
		const summaryPortion = text.slice(idx + marker.length);
		expect(summaryPortion.length).toBe(500);
		// And it is a prefix of the real serialization, not the placeholder.
		expect(summaryPortion).toBe(JSON.stringify({ blob: big }).slice(0, 500));
	});
});

// ===========================================
// Missing-context branch (get_work_context rejects)
// ===========================================
describe("handoff: context-fetch failure is non-fatal", () => {
	it("continues the handoff with the 'No context available' summary when get_work_context throws", async () => {
		installClient({
			callTool: (name) => {
				if (name === "get_work_context") {
					throw new Error("context service down");
				}
				return { sent: true };
			},
		});
		await handoffCommand("alpha", "bravo", { json: true });

		// send_message still happened despite the context failure.
		const body = String(callTo("send_message")?.args.body_md);
		expect(body).toContain("No context available");
		expect(body).not.toContain("context service down");
		// The JSON result reports context as unavailable but the message as sent.
		expect(JSON.parse(rawOut())).toEqual({
			from: "alpha",
			to: "bravo",
			context_available: false,
			message_sent: true,
		});
		// No error surfaced — the failure was swallowed intentionally.
		expect(err()).toBe("");
		expect(process.exitCode).toBeUndefined();
	});

	it("treats a null context result as unavailable (context_available: false)", async () => {
		// get_work_context resolves but with null → the `context ? ... : ...`
		// false branch and !!context === false.
		installClient({
			callTool: (name) => (name === "get_work_context" ? null : { sent: true }),
		});
		await handoffCommand("alpha", "bravo", { json: true });

		expect(String(callTo("send_message")?.args.body_md)).toContain("No context available");
		expect(JSON.parse(rawOut()).context_available).toBe(false);
	});
});

// ===========================================
// Output mode: json
// ===========================================
describe("handoff: json output", () => {
	it("prints the full handoff result with context_available true when context exists", async () => {
		installClient({ callTool: () => ({ anything: "here" }) });
		await handoffCommand("from-x", "to-y", { json: true });
		expect(JSON.parse(rawOut())).toEqual({
			from: "from-x",
			to: "to-y",
			context_available: true,
			message_sent: true,
		});
		// json mode never emits the human header lines.
		expect(out()).not.toContain("Agent Handoff");
	});
});

// ===========================================
// Output mode: normal (default human render)
// ===========================================
describe("handoff: normal output", () => {
	it("renders the header, From/To, 'included' context, and a completion line", async () => {
		installClient({ callTool: () => ({ some: "context" }) });
		await handoffCommand("nova", "orion", {});
		const text = out();
		expect(text).toContain("Agent Handoff");
		expect(text).toContain("From");
		expect(text).toContain("nova");
		expect(text).toContain("To");
		expect(text).toContain("orion");
		// context present → "included" branch (line 72).
		expect(text).toContain("included");
		expect(text).not.toContain("unavailable");
		expect(text).toContain("sent");
		expect(text).toContain("Handoff complete. orion has been notified.");
		expect(process.exitCode).toBeUndefined();
	});

	it("renders 'unavailable' context when the source agent has no work context", async () => {
		installClient({
			callTool: (name) => {
				if (name === "get_work_context") throw new Error("nope");
				return { sent: true };
			},
		});
		await handoffCommand("nova", "orion", {});
		const text = out();
		expect(text).toContain("unavailable");
		expect(text).not.toContain("included");
		// Completion line still printed — handoff succeeded sans context.
		expect(text).toContain("Handoff complete. orion has been notified.");
	});
});

// ===========================================
// Output modes without a dedicated renderer fall through to normal()
// ===========================================
describe("handoff: short / full modes reuse the normal renderer", () => {
	it("--short produces the same normal render (no short renderer provided)", async () => {
		installClient({ callTool: () => ({ c: 1 }) });
		await handoffCommand("p", "q", { short: true });
		const text = out();
		expect(text).toContain("Agent Handoff");
		expect(text).toContain("Handoff complete. q has been notified.");
	});

	it("--full produces the same normal render (no full renderer provided)", async () => {
		installClient({ callTool: () => ({ c: 1 }) });
		await handoffCommand("p", "q", { full: true });
		const text = out();
		expect(text).toContain("Agent Handoff");
		expect(text).toContain("Handoff complete. q has been notified.");
	});
});

// ===========================================
// Outer catch: send_message failure
// ===========================================
describe("handoff: send failure handling", () => {
	it("reports an Error message from send_message in normal mode", async () => {
		installClient({
			callTool: (name) => {
				if (name === "send_message") throw new Error("delivery refused");
				return { ctx: true };
			},
		});
		await handoffCommand("alpha", "bravo", {});
		expect(err()).toBe("Error: Handoff failed: delivery refused");
		expect(process.exitCode).toBe(1);
		// The success completion line must NOT have printed.
		expect(out()).not.toContain("Handoff complete");
	});

	it("stringifies a non-Error reject from send_message (String(err) branch)", async () => {
		installClient({
			callTool: (name) => {
				if (name === "send_message") {
					throw "raw string failure";
				}
				return { ctx: true };
			},
		});
		await handoffCommand("alpha", "bravo", {});
		expect(err()).toBe("Error: Handoff failed: raw string failure");
		expect(process.exitCode).toBe(1);
	});

	it("emits a structured JSON error when the handoff fails in --json mode", async () => {
		installClient({
			callTool: (name) => {
				if (name === "send_message") throw new Error("boom");
				return { ctx: true };
			},
		});
		await handoffCommand("alpha", "bravo", { json: true });
		expect(JSON.parse(err())).toEqual({
			error: "Handoff failed: boom",
			details: undefined,
		});
		expect(process.exitCode).toBe(1);
	});
});
