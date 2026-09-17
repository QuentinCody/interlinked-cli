import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createJevClient,
	JEV_DEFAULT_ENDPOINT,
	JEV_DEFAULT_MODEL,
	JEV_USD_PER_INPUT_TOKEN,
	JevClient,
	parseJevResponse,
} from "./client.js";

const OK_BODY = {
	model: "jev-1.13.0",
	answers: {
		yes: { type: "noul", noul: 0.91 },
		pick: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.6 },
		rate: { type: "score", score: 1.5, legend: { "0": "low", "1": "mid", "2": "high" }, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 }, confidence: 0.5 },
	},
	usage: { input_tokens: 400, output_tokens: 12 },
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const QUESTIONS = { yes: { type: "noul" as const, instructions: "Is it?" } };

describe("parseJevResponse — positive (must fire)", () => {
	it("P1: accepts all three answer shapes and the usage block", () => {
		const parsed = parseJevResponse(OK_BODY);
		expect(parsed?.model).toBe("jev-1.13.0");
		expect(parsed?.answers.yes).toEqual({ type: "noul", noul: 0.91 });
		expect(parsed?.answers.pick?.type).toBe("choice");
		expect(parsed?.answers.rate?.type).toBe("score");
		expect(parsed?.usage.input_tokens).toBe(400);
	});
});

describe("parseJevResponse — negative (must not fire)", () => {
	it("N1: rejects a body with a malformed answer", () => {
		expect(parseJevResponse({ ...OK_BODY, answers: { yes: { type: "noul" } } })).toBeNull();
	});
	it("N2: rejects a body without usage", () => {
		expect(parseJevResponse({ model: "m", answers: {} })).toBeNull();
	});
	it("N3: rejects non-object input", () => {
		expect(parseJevResponse("nope")).toBeNull();
	});
});

describe("JevClient.ask — positive (must fire)", () => {
	it("P1: posts model+state+questions with the bearer key and returns the parsed body", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
		const client = new JevClient({ apiKey: "k-1", fetchImpl });
		const res = await client.ask({ text: "hi" }, QUESTIONS);
		expect(res?.answers.yes).toEqual({ type: "noul", noul: 0.91 });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]; // SAFETY: vi.fn records exactly the (url, init) pair the client passes
		expect(url).toBe(JEV_DEFAULT_ENDPOINT);
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer k-1");
		expect(JSON.parse(String(init.body))).toEqual({ model: JEV_DEFAULT_MODEL, state: { text: "hi" }, questions: QUESTIONS });
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("P2: accumulates spend from usage.input_tokens at list price", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => jsonResponse(OK_BODY) });
		await client.ask("s", QUESTIONS);
		await client.ask("s", QUESTIONS);
		expect(client.spend()).toEqual({ calls: 2, failures: 0, input_tokens: 800, usd: 800 * JEV_USD_PER_INPUT_TOKEN });
	});

	it("P3: honors endpoint and model overrides from config", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
		const client = new JevClient({ apiKey: "k", fetchImpl, config: { endpoint: "http://localhost:9/x", model: "jev-1.12" } });
		await client.ask("s", QUESTIONS);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]; // SAFETY: same (url, init) pair as P1
		expect(url).toBe("http://localhost:9/x");
		expect(JSON.parse(String(init.body)).model).toBe("jev-1.12");
	});
});

describe("JevClient.ask — negative (must not fire / fail-open)", () => {
	it("N1: an HTTP error resolves to null and counts a failure", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => jsonResponse({ detail: "overloaded" }, 529) });
		expect(await client.ask("s", QUESTIONS)).toBeNull();
		expect(client.spend().failures).toBe(1);
	});
	it("N2: a thrown fetch (timeout/network) resolves to null", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => { throw new Error("aborted"); } });
		expect(await client.ask("s", QUESTIONS)).toBeNull();
	});
	it("N3: a 200 with a malformed body resolves to null", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => jsonResponse({ model: "m" }) });
		expect(await client.ask("s", QUESTIONS)).toBeNull();
	});
	it("N4: stops calling once the spend ceiling is crossed", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
		const client = new JevClient({ apiKey: "k", fetchImpl, config: { max_spend_usd: 400 * JEV_USD_PER_INPUT_TOKEN } });
		expect(await client.ask("s", QUESTIONS)).not.toBeNull();
		expect(await client.ask("s", QUESTIONS)).toBeNull();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("createJevClient", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	it("N1: returns null when the jev block is absent or disabled (default OFF)", () => {
		vi.stubEnv("TYPESAFE_API_KEY", "k");
		expect(createJevClient(undefined)).toBeNull();
		expect(createJevClient({ enabled: false })).toBeNull();
	});
	it("N2: returns null when enabled but no key resolves", () => {
		vi.stubEnv("TYPESAFE_API_KEY", "");
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-dir-for-jev-test");
		expect(createJevClient({ enabled: true })).toBeNull();
		spy.mockRestore();
	});
	it("P1: returns a client when enabled and the env key is set", () => {
		vi.stubEnv("TYPESAFE_API_KEY", "k-env");
		expect(createJevClient({ enabled: true })).toBeInstanceOf(JevClient);
	});
});
