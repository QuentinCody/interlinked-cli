import { wireAbsentOptional, parseWire, wireBoolean, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
// ===========================================
// interlinked send — behavioral coverage (companion to send.ts)
// ===========================================
// Drives sendCommand through EVERY branch of the source:
//   - auth gate: unauthenticated+remote (error) / unauthenticated+localdev
//     (proceeds) / authenticated
//   - body resolution: message argument / --file read success / --file read
//     failure (error) / message undefined falling through to "" then file
//   - empty-body guard: no message + no file / whitespace-only message / file
//   - agent_name guard: missing / whitespace-only (trim -> falsy) / present
//   - callTool args: importance passed through vs defaulted to "normal",
//     to[] wrapping, sender_name from config, body_md from message/file
//   - success rendering: normal mode (green "Message sent to ...") and json
//     mode (raw result echoed)
//   - catch path: thrown Error (uses .message) and non-Error throwable
//     (uses String(err)); the "Is the Server reachable?" hint surfaces in the
//     json-mode structured payload
//   - opts entirely undefined -> getOutputMode(opts || {}) + opts?.file/?.importance
//
// `../lib/api-client.js` is the network surface and is fully mocked via a
// single fake client. `node:fs` is mocked per the harness contract so no test
// can reach the filesystem even by accident. `../lib/formatter.js` is mocked to
// identity renderers so output assertions are exact strings rather than
// ANSI-sensitive substrings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCallTool,
	mockIsAuthenticated,
	mockIsLocalDevServer,
	mockGetConfig,
	mockReadFileSync,
} = vi.hoisted(() => ({
	mockCallTool: vi.fn(),
	mockIsAuthenticated: vi.fn().mockReturnValue(true),
	mockIsLocalDevServer: vi.fn().mockReturnValue(false),
	mockGetConfig: vi.fn().mockReturnValue({ agent_name: "agent-default" }),
	mockReadFileSync: vi.fn(),
}));

vi.mock("../lib/api-client.js", () => ({
	getClient: () => ({
		callTool: mockCallTool,
		isAuthenticated: mockIsAuthenticated,
		isLocalDevServer: mockIsLocalDevServer,
		getConfig: mockGetConfig,
	}),
	InterlinkedClient: vi.fn(),
}));

vi.mock("node:fs", () => ({
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// Identity formatter: assertions check exact strings, not ANSI codes.
vi.mock("../lib/formatter.js", () => ({
	c: {
		green: (s: string) => s,
		bold: (s: string) => s,
	},
}));

import { sendCommand } from "./send.js";

/** Concatenate every console.error argument across all calls into one string. */
function allErr(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((call) => call.map((a) => String(a)).join(" "))
		.join("\n");
}

/** Concatenate every console.log argument across all calls into one string. */
function allLog(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((call) => call.map((a) => String(a)).join(" "))
		.join("\n");
}

beforeEach(() => {
	vi.clearAllMocks();
	mockIsAuthenticated.mockReturnValue(true);
	mockIsLocalDevServer.mockReturnValue(false);
	mockGetConfig.mockReturnValue({ agent_name: "agent-default" });
	mockReadFileSync.mockReset();
	process.exitCode = 0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	process.exitCode = 0;
	vi.restoreAllMocks();
});

describe("sendCommand — authentication gate", () => {
	it("blocks when unauthenticated against a remote server", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(false);

		await sendCommand("agent-1", "hi", { json: true });

		expect(mockCallTool).not.toHaveBeenCalled();
		const err = allErr();
		expect(err).toContain("Not authenticated");
		expect(err).toContain("interlinked login");
		expect(process.exitCode).toBe(1);
	});

	it("proceeds when unauthenticated but pointed at a localhost dev server", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(true);
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-1", "hi");

		expect(mockCallTool).toHaveBeenCalledWith("send_message", {
			sender_name: "agent-default",
			to: ["agent-1"],
			body_md: "hi",
			importance: "normal",
		});
	});

	it("proceeds when authenticated against a remote server", async () => {
		mockIsAuthenticated.mockReturnValue(true);
		mockIsLocalDevServer.mockReturnValue(false);
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-1", "hi");

		expect(mockCallTool).toHaveBeenCalledWith("send_message", {
			sender_name: "agent-default",
			to: ["agent-1"],
			body_md: "hi",
			importance: "normal",
		});
	});
});

describe("sendCommand — message body resolution", () => {
	it("sends the inline message argument verbatim", async () => {
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-1", "Hello there");

		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({ body_md: "Hello there" }),
		);
	});

	it("reads the body from --file when provided", async () => {
		mockReadFileSync.mockReturnValue("body from disk\n");
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-1", undefined, { file: "/tmp/msg.md" });

		expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/msg.md", "utf-8");
		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({ body_md: "body from disk\n" }),
		);
	});

	it("--file overrides the inline message argument", async () => {
		mockReadFileSync.mockReturnValue("file wins");
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-1", "inline loses", { file: "/tmp/msg.md" });

		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({ body_md: "file wins" }),
		);
	});

	it("errors and aborts when --file cannot be read", async () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		await sendCommand("agent-1", "ignored", { file: "/nope/missing.md" });

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(allErr()).toContain("Could not read file: /nope/missing.md");
		expect(process.exitCode).toBe(1);
	});
});

describe("sendCommand — empty-body guard", () => {
	it("rejects when neither a message nor a file is given", async () => {
		await sendCommand("agent-1", undefined);

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(allErr()).toContain("Message body is empty");
		expect(process.exitCode).toBe(1);
	});

	it("rejects an explicit empty-string message", async () => {
		await sendCommand("agent-1", "");

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(allErr()).toContain("Message body is empty");
	});

	it("rejects a whitespace-only message (trim guard)", async () => {
		await sendCommand("agent-1", "   \n\t  ");

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(allErr()).toContain("Message body is empty");
	});

	it("rejects a file whose contents are only whitespace", async () => {
		mockReadFileSync.mockReturnValue("\n   \t\n");

		await sendCommand("agent-1", undefined, { file: "/tmp/blank.md" });

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(allErr()).toContain("Message body is empty");
	});
});

describe("sendCommand — agent_name guard", () => {
	it("errors when agent_name is absent from config", async () => {
		mockGetConfig.mockReturnValue({});

		await sendCommand("agent-1", "hi");

		expect(mockCallTool).not.toHaveBeenCalled();
		const err = allErr();
		expect(err).toContain("agent_name is required");
		expect(err).toContain("INTERLINKED_AGENT_NAME");
		expect(process.exitCode).toBe(1);
	});

	it("errors when agent_name is whitespace-only (trims to empty)", async () => {
		mockGetConfig.mockReturnValue({ agent_name: "   " });

		await sendCommand("agent-1", "hi");

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(allErr()).toContain("agent_name is required");
	});

	it("trims surrounding whitespace from a valid agent_name", async () => {
		mockGetConfig.mockReturnValue({ agent_name: "  agent-trimmed  " });
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-1", "hi");

		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({ sender_name: "agent-trimmed" }),
		);
	});
});

describe("sendCommand — callTool arguments", () => {
	it("wraps the recipient in an array and defaults importance to normal", async () => {
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-7", "ping");

		expect(mockCallTool).toHaveBeenCalledWith("send_message", {
			sender_name: "agent-default",
			to: ["agent-7"],
			body_md: "ping",
			importance: "normal",
		});
	});

	it("passes an explicit importance through unchanged", async () => {
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-7", "ping", { importance: "urgent" });

		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({ importance: "urgent" }),
		);
	});
});

describe("sendCommand — success rendering", () => {
	it("prints a green confirmation in normal mode", async () => {
		mockCallTool.mockResolvedValue({ sent: true });

		await sendCommand("agent-99", "done");

		// Formatter mocked to identity, so the rendered line is plain text.
		expect(allLog()).toContain("Message sent to agent-99");
		// Success path must not set an error exit code.
		expect(process.exitCode).toBe(0);
	});

	it("echoes the raw tool result as JSON in --json mode", async () => {
		mockCallTool.mockResolvedValue({ message_id: "m-123", delivered: true });

		await sendCommand("agent-99", "done", { json: true });

		const logged = allLog();
		const parsed = parseWire(JSON.parse(logged), wireObject({ "message_id": wireAbsentOptional(wireOptional(wireString)), "delivered": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value");
		expect(parsed.message_id).toBe("m-123");
		expect(parsed.delivered).toBe(true);
		// JSON success mode must not print the human confirmation line.
		expect(logged).not.toContain("Message sent to");
	});
});

describe("sendCommand — server error handling", () => {
	it("reports a thrown Error's message (normal mode)", async () => {
		mockCallTool.mockRejectedValue(new Error("connection refused"));

		await sendCommand("agent-1", "hi");

		expect(allErr()).toContain("Server error: connection refused");
		expect(process.exitCode).toBe(1);
	});

	it("emits a structured error carrying the reachability hint in --json mode", async () => {
		mockCallTool.mockRejectedValue(new Error("connection refused"));

		await sendCommand("agent-1", "hi", { json: true });

		// In json mode outputError serializes { error, details } — the hint
		// object passed by sendCommand surfaces in the structured payload.
		const parsed = parseWire(JSON.parse(allErr()), wireObject({ "error": wireAbsentOptional(wireOptional(wireString)), "details": wireAbsentOptional(wireOptional(wireObject({ "hint": wireAbsentOptional(wireOptional(wireString)) }))) }), "test JSON value");
		expect(parsed.error).toContain("Server error: connection refused");
		expect(parsed.details?.hint).toBe("Is the Server reachable?");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error throwable", async () => {
		mockCallTool.mockRejectedValue("plain string failure");

		await sendCommand("agent-1", "hi");

		expect(allErr()).toContain("Server error: plain string failure");
		expect(process.exitCode).toBe(1);
	});
});

describe("sendCommand — opts omitted entirely", () => {
	it("defaults output mode and treats file/importance as absent", async () => {
		mockCallTool.mockResolvedValue({ sent: true });

		// No opts object at all: exercises getOutputMode(opts || {}),
		// opts?.file (undefined), and opts?.importance (-> "normal").
		await sendCommand("agent-1", "hello");

		expect(mockReadFileSync).not.toHaveBeenCalled();
		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({ importance: "normal" }),
		);
		expect(allLog()).toContain("Message sent to agent-1");
	});
});
