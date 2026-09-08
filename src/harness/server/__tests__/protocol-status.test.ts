import { makeServerRules } from "./fixtures.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../daemon-protocol.js";
import type { GuardRulesConfig } from "../../types.js";
import {
	buildStartupMessage,
	computeClassifierStatusLine,
	createProtocolStatus,
	formatScannerStatusLine,
	type ProtocolStatusFile,
	recordProtocolEvent,
	writeProtocolStatus,
} from "../protocol-status.js";

function baseStatus(): ProtocolStatusFile {
	return createProtocolStatus({
		protocol: "dual",
		rawSocketPath: "/tmp/raw.sock",
		framedSocketPath: "/tmp/framed.sock",
		framedSessionId: "sess-1",
	});
}

describe("createProtocolStatus", () => {
	it("stamps the protocol, version, and socket paths", () => {
		const s = baseStatus();
		expect(s.protocol).toBe("dual");
		expect(s.protocol_version).toBe(PROTOCOL_VERSION);
		expect(s.raw_socket_path).toBe("/tmp/raw.sock");
		expect(s.framed_socket_path).toBe("/tmp/framed.sock");
		expect(s.framed_session_id).toBe("sess-1");
	});

	it("initializes all counters to zero and last-event times to null", () => {
		const s = baseStatus();
		expect(s.raw_event_count).toBe(0);
		expect(s.framed_event_count).toBe(0);
		expect(s.framed_error_count).toBe(0);
		expect(s.framed_timeout_count).toBe(0);
		expect(s.last_raw_event_at).toBeNull();
		expect(s.last_framed_event_at).toBeNull();
	});

	it("sets started_at to a parseable ISO timestamp", () => {
		const s = baseStatus();
		expect(Number.isNaN(Date.parse(s.started_at))).toBe(false);
	});

	it("allows null socket paths (single-protocol mode)", () => {
		const s = createProtocolStatus({
			protocol: "raw",
			rawSocketPath: "/tmp/raw.sock",
			framedSocketPath: null,
			framedSessionId: null,
		});
		expect(s.framed_socket_path).toBeNull();
		expect(s.framed_session_id).toBeNull();
	});
});

describe("recordProtocolEvent", () => {
	it("increments the raw counter and stamps last_raw_event_at", () => {
		const s = baseStatus();
		recordProtocolEvent(s, "raw", "2026-06-01T00:00:00.000Z");
		expect(s.raw_event_count).toBe(1);
		expect(s.last_raw_event_at).toBe("2026-06-01T00:00:00.000Z");
		// framed side untouched
		expect(s.framed_event_count).toBe(0);
		expect(s.last_framed_event_at).toBeNull();
	});

	it("increments the framed counter and stamps last_framed_event_at", () => {
		const s = baseStatus();
		recordProtocolEvent(s, "framed", "2026-06-01T01:00:00.000Z");
		expect(s.framed_event_count).toBe(1);
		expect(s.last_framed_event_at).toBe("2026-06-01T01:00:00.000Z");
		expect(s.raw_event_count).toBe(0);
	});

	it("accumulates across multiple calls", () => {
		const s = baseStatus();
		recordProtocolEvent(s, "raw");
		recordProtocolEvent(s, "raw");
		recordProtocolEvent(s, "framed");
		expect(s.raw_event_count).toBe(2);
		expect(s.framed_event_count).toBe(1);
	});
});

describe("writeProtocolStatus", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "proto-status-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes pretty-printed JSON with a trailing newline", () => {
		const s = baseStatus();
		const p = join(dir, "harness-protocol.json");
		writeProtocolStatus(p, s);
		const raw = readFileSync(p, "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw)).toMatchObject({ protocol: "dual", raw_event_count: 0 });
	});

	it("creates the parent directory on demand", () => {
		const p = join(dir, "nested", "deep", "harness-protocol.json");
		writeProtocolStatus(p, baseStatus());
		expect(existsSync(p)).toBe(true);
	});

	it("swallows write errors (path is a directory)", () => {
		// Writing to the directory itself throws EISDIR inside; must not propagate.
		expect(() => writeProtocolStatus(dir, baseStatus())).not.toThrow();
	});
});

describe("formatScannerStatusLine", () => {
	it("formats ready with a pid", () => {
		expect(formatScannerStatusLine({ state: "ready", pid: 4242 })).toBe("ready:4242");
	});

	it("falls back to ? when ready has no pid", () => {
		expect(formatScannerStatusLine({ state: "ready" })).toBe("ready:?");
	});

	it("maps dormant verbatim", () => {
		expect(formatScannerStatusLine({ state: "dormant" })).toBe("dormant");
	});

	it("collapses starting and idle to starting", () => {
		expect(formatScannerStatusLine({ state: "starting" })).toBe("starting");
		expect(formatScannerStatusLine({ state: "idle" })).toBe("starting");
	});

	it("formats disabled with a detail reason", () => {
		expect(formatScannerStatusLine({ state: "disabled", detail: "no_key" })).toBe(
			"down:no_key",
		);
	});

	it("uses 'unknown' when disabled has no detail", () => {
		expect(formatScannerStatusLine({ state: "disabled" })).toBe("down:unknown");
	});

	it("passes unrecognized states through unchanged", () => {
		expect(formatScannerStatusLine({ state: "weird" })).toBe("weird");
	});
});

describe("buildStartupMessage", () => {
	it("lists both sockets, pid, and rule count", () => {
		const msg = buildStartupMessage({
			protocol: "dual",
			rawSocketPath: "/tmp/raw.sock",
			framedSocketPath: "/tmp/framed.sock",
			pid: 999,
			ruleCount: 116,
			idleTimeoutMs: 0,
			msPerMinute: 60_000,
		});
		expect(msg).toContain("(dual)");
		expect(msg).toContain("raw /tmp/raw.sock");
		expect(msg).toContain("framed /tmp/framed.sock");
		expect(msg).toContain("PID 999");
		expect(msg).toContain("116 rules");
	});

	it("omits the idle-timeout suffix when disabled (0)", () => {
		const msg = buildStartupMessage({
			protocol: "raw",
			rawSocketPath: "/tmp/raw.sock",
			framedSocketPath: null,
			pid: 1,
			ruleCount: 1,
			idleTimeoutMs: 0,
			msPerMinute: 60_000,
		});
		expect(msg).not.toContain("idle timeout");
		expect(msg).not.toContain("framed");
	});

	it("includes the idle-timeout suffix in minutes when set", () => {
		const msg = buildStartupMessage({
			protocol: "framed",
			rawSocketPath: null,
			framedSocketPath: "/tmp/framed.sock",
			pid: 7,
			ruleCount: 3,
			idleTimeoutMs: 120_000,
			msPerMinute: 60_000,
		});
		expect(msg).toContain("idle timeout 2min");
		// raw socket omitted when null
		expect(msg).not.toContain("raw ");
	});
});

describe("computeClassifierStatusLine", () => {
	function rules(
		partial: Partial<GuardRulesConfig["policy_classifier"]> | undefined,
	): GuardRulesConfig {
		return { ...makeServerRules(), ...(partial && { policy_classifier: { enabled: false, mode: "shadow", provider: "claude_code", endpoint: "", api_key_env: "", model: "fixture", timeout_ms: 3000, max_input_tokens: 800, confidence_threshold: 0.8, max_calls_per_session: 50, ...partial } }) };
	}

	it("returns disabled when there is no policy_classifier", () => {
		expect(computeClassifierStatusLine(rules(undefined))).toBe("disabled");
	});

	it("returns disabled when policy_classifier.enabled is false", () => {
		expect(
			computeClassifierStatusLine(rules({ enabled: false, provider: "groq", model: "m" })),
		).toBe("disabled");
	});

	it("returns ready for the claude_code provider (needs no API key)", () => {
		expect(
			computeClassifierStatusLine(
				rules({ enabled: true, provider: "claude_code", model: "sonnet" }),
			),
		).toBe("claude_code:sonnet:ready");
	});

	it("returns no_key when an API-key env var is unset", () => {
		const envName = "INTERLINKED_TEST_MISSING_KEY_XYZ";
		delete process.env[envName];
		expect(
			computeClassifierStatusLine(
				rules({
					enabled: true,
					provider: "groq",
					model: "llama",
					api_key_env: envName,
				}),
			),
		).toBe("groq:llama:no_key");
	});
});
