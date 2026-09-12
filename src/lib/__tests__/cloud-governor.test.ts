import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../non-null.js";
import type { HarnessEvent } from "../../harness/types.js";
import { type CloudGovernorConfig, evaluateRemote } from "../cloud-governor.js";

const ENABLED_CONFIG: CloudGovernorConfig = {
	enabled: true,
	url: "https://example.com/governor/evaluate",
	bearer_token: "t",
	timeout_ms: 1000,
};

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: "2026-05-28T00:00:00Z",
		...overrides,
	};
}

describe("evaluateRemote", () => {
	let fetchSpy = vi.fn<typeof fetch>();
	beforeEach(() => {
		fetchSpy = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchSpy);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns null when disabled", async () => {
		const result = await evaluateRemote(makeEvent(), { ...ENABLED_CONFIG, enabled: false });
		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each([null, [], 42])("ignores non-object remote verdicts: %j", async (value) => {
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(value), { status: 200 }));
		const { timeout_ms: _timeout, ...config } = ENABLED_CONFIG;
		expect(await evaluateRemote(makeEvent(), config)).toBeNull();
	});

	it("returns null when url is missing", async () => {
		const result = await evaluateRemote(makeEvent(), { ...ENABLED_CONFIG, url: "" });
		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns null when bearer_token is missing", async () => {
		const result = await evaluateRemote(makeEvent(), { ...ENABLED_CONFIG, bearer_token: "" });
		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("forwards the event with correct method, auth, and content-type", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ decision: "allow" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const event = makeEvent({ tool_input: { command: "cf dns records delete --id abc" } });
		await evaluateRemote(event, ENABLED_CONFIG);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, rawInit] = nonNull(fetchSpy.mock.calls[0]);
		const init = nonNull(rawInit);
		expect(url).toBe(ENABLED_CONFIG.url);
		expect(init.method).toBe("POST");
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${ENABLED_CONFIG.bearer_token}`);
		expect(headers.get("content-type")).toBe("application/json");
		if (typeof init.body !== "string") throw new Error("Expected serialized request body");
		const body: unknown = JSON.parse(init.body);
		expect(body).toHaveProperty("tool_input", { command: "cf dns records delete --id abc" });
	});

	it("returns parsed allow verdict", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ decision: "allow" }), { status: 200 }),
		);
		const result = await evaluateRemote(makeEvent(), ENABLED_CONFIG);
		expect(result).toEqual({ decision: "allow" });
	});

	it("returns parsed warn verdict with rule_id and warnings", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					decision: "allow",
					warnings: ["DNS record deletion has wide blast radius"],
					rule_id: "cloud-builtin-cf-dns-record-delete",
				}),
				{ status: 200 },
			),
		);
		const result = await evaluateRemote(makeEvent(), ENABLED_CONFIG);
		expect(result?.decision).toBe("allow");
		expect(result?.warnings?.[0]).toContain("DNS");
		expect(result?.rule_id).toBe("cloud-builtin-cf-dns-record-delete");
	});

	it("returns parsed block verdict", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ decision: "block", reason: "nope" }), { status: 200 }),
		);
		const result = await evaluateRemote(makeEvent(), ENABLED_CONFIG);
		expect(result).toEqual({ decision: "block", reason: "nope" });
	});

	it("returns null on non-2xx response (fail-open)", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("internal error", { status: 500 }));
		const result = await evaluateRemote(makeEvent(), ENABLED_CONFIG);
		expect(result).toBeNull();
	});

	it("returns null on unparseable response (fail-open)", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("not json", { status: 200 }));
		const result = await evaluateRemote(makeEvent(), ENABLED_CONFIG);
		expect(result).toBeNull();
	});

	it("returns null on response with unknown decision (fail-open)", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ decision: "weird" }), { status: 200 }),
		);
		const result = await evaluateRemote(makeEvent(), ENABLED_CONFIG);
		expect(result).toBeNull();
	});

	it("returns null when fetch rejects (network error)", async () => {
		fetchSpy.mockRejectedValueOnce(new TypeError("network"));
		const result = await evaluateRemote(makeEvent(), ENABLED_CONFIG);
		expect(result).toBeNull();
	});

	it("returns null when the request aborts on timeout", async () => {
		fetchSpy.mockImplementationOnce(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					const signal = nonNull(init?.signal);
					signal.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		);
		const result = await evaluateRemote(makeEvent(), { ...ENABLED_CONFIG, timeout_ms: 10 });
		expect(result).toBeNull();
	});
});
