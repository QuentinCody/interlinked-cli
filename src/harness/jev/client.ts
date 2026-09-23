// Jev (TypeSafe System One) — minimal fail-open HTTP client.
//
// One fetch per `ask`; no SDK. Every failure (disabled, no key, timeout, HTTP
// error, malformed body, spend ceiling) resolves to `null` so callers degrade
// to "not measured" — a Jev verdict is a SCORING signal merged tighten-only,
// never a gate (docs/external-pulse/typesafe-jev.md §3b). The spend ledger is
// per client instance: the internal runner creates a client per action, so
// `max_spend_usd` bounds that action, not an install. No public hook calls Jev.

import { resolveApiKey } from "../policy-classifier.js";
import type { JevAnswer, JevConfig, JevEntry, JevQuestion, JevResponse } from "./types.js";

export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_DEFAULT_TIMEOUT_MS = 5_000;
export const JEV_DEFAULT_MAX_SPEND_USD = 0.25;
/** List price at landing (2026-09): $0.042 per million input tokens; output is free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Injectable fetch (tests, proxies); global `fetch` by default. */
export type JevFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface JevClientOptions {
	apiKey: string;
	config?: JevConfig;
	/** Injected in tests; defaults to global fetch. */
	fetchImpl?: JevFetch;
}

export interface JevSpend {
	calls: number;
	failures: number;
	input_tokens: number;
	usd: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAnswer(v: unknown): v is JevAnswer {
	if (!isRecord(v) || typeof v.type !== "string") return false;
	if (v.type === "noul") return typeof v.noul === "number";
	if (v.type === "choice") return typeof v.choice === "string" && typeof v.confidence === "number" && isRecord(v.probabilities);
	if (v.type === "score") return typeof v.score === "number" && typeof v.confidence === "number" && isRecord(v.probabilities);
	return false;
}

/** Boundary parse: a 200 with any other shape is a failure, not a crash. */
export function parseJevResponse(raw: unknown): JevResponse | null {
	if (!isRecord(raw) || typeof raw.model !== "string" || !isRecord(raw.answers) || !isRecord(raw.usage)) return null;
	const answers: Record<string, JevAnswer> = {};
	for (const [id, a] of Object.entries(raw.answers)) {
		if (!isAnswer(a)) return null;
		answers[id] = a;
	}
	const input = raw.usage.input_tokens;
	const output = raw.usage.output_tokens;
	if (typeof input !== "number" || typeof output !== "number") return null;
	return { model: raw.model, answers, usage: { input_tokens: input, output_tokens: output } };
}

export class JevClient {
	private readonly apiKey: string;
	private readonly endpoint: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly maxSpendUsd: number;
	private readonly fetchImpl: JevFetch;
	private readonly ledger: JevSpend = { calls: 0, failures: 0, input_tokens: 0, usd: 0 };

	constructor(opts: JevClientOptions) {
		this.apiKey = opts.apiKey;
		this.endpoint = opts.config?.endpoint ?? JEV_DEFAULT_ENDPOINT;
		this.model = opts.config?.model ?? JEV_DEFAULT_MODEL;
		this.timeoutMs = opts.config?.timeout_ms ?? JEV_DEFAULT_TIMEOUT_MS;
		this.maxSpendUsd = opts.config?.max_spend_usd ?? JEV_DEFAULT_MAX_SPEND_USD;
		this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	}

	/** Snapshot of this client's spend so far. */
	spend(): JevSpend {
		return { ...this.ledger };
	}

	/** Evaluate `questions` against `state`; `null` on any failure or when the spend ceiling is crossed. */
	async ask(state: JevEntry, questions: Record<string, JevQuestion>): Promise<JevResponse | null> {
		if (this.ledger.usd >= this.maxSpendUsd) return null;
		this.ledger.calls++;
		try {
			const res = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, state, questions }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!res.ok) return this.fail();
			const parsed = parseJevResponse(await res.json());
			if (!parsed) return this.fail();
			this.ledger.input_tokens += parsed.usage.input_tokens;
			this.ledger.usd += parsed.usage.input_tokens * JEV_USD_PER_INPUT_TOKEN;
			return parsed;
		} catch {
			return this.fail();
		}
	}

	private fail(): null {
		this.ledger.failures++;
		return null;
	}
}

/**
 * Build a client from config + resolved key, or `null` when Jev is disabled
 * (default) or no key is available. Callers treat `null` as "not measured".
 */
export function createJevClient(config: JevConfig | undefined, fetchImpl?: JevFetch): JevClient | null {
	if (config?.enabled !== true) return null;
	const apiKey = resolveApiKey(JEV_API_KEY_ENV);
	if (!apiKey) return null;
	return new JevClient(fetchImpl ? { apiKey, config, fetchImpl } : { apiKey, config });
}
