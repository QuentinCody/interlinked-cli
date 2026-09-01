// ===========================================
// Content Scanner — HTTP backend (HF Inference API / custom endpoint)
// ===========================================
//
// Minimal fetch wrapper that posts `{inputs: text}` and parses the standard
// HuggingFace token-classification response shape into `ScanFinding[]`.
//
// Usable targets today:
//   - `runtime: "huggingface"` with `model: "openai/gpt-oss-safeguard-20b"`
//     (and any other standard-architecture token-classification model).
//   - `runtime: "custom_http"` with a self-hosted TGI/vLLM endpoint that
//     exposes the same response shape.
//
// NOT usable for `openai/privacy-filter`: that model requires
// `trust_remote_code=True` and is not served by the free HF Inference API.
// Use the local sidecar for privacy-filter today.

import type { JsonObject } from "../../lib/json-types.js";
import type {
	ContentScanner,
	ContentScannerConfig,
	ScanFinding,
	ScanRequest,
} from "./types.js";

/** HuggingFace Inference API token-classification response shape
 *  (aggregation_strategy=simple). One object per detected entity span. */
interface HfTokenClassificationEntity {
	entity_group: string;
	score: number;
	word: string;
	start: number;
	end: number;
}

/** Optional DI seam for tests — defaults to the global `fetch`. */
type FetchFn = typeof fetch;

interface OpfHttpScannerOptions {
	/** Test hook —defaults to `globalThis.fetch`. */
	fetchFn?: FetchFn;
	/** Test hook — override env lookup. Defaults to `process.env[varName]`. */
	resolveEnv?: (varName: string) => string | undefined;
}

export class OpfHttpScanner implements ContentScanner {
	readonly name: string;
	readonly runtime = "http" as const;
	private readonly endpoint: string;
	private readonly apiKey: string | undefined;
	private readonly timeoutMs: number;
	private readonly fetchFn: FetchFn;

	constructor(config: ContentScannerConfig, opts: OpfHttpScannerOptions = {}) {
		this.fetchFn = opts.fetchFn ?? globalThis.fetch;
		const envResolver = opts.resolveEnv ?? defaultEnvResolver;

		if (config.runtime === "huggingface") {
			this.name = `hf:${config.huggingface.model}`;
			this.endpoint = `https://api-inference.huggingface.co/models/${config.huggingface.model}`;
			this.apiKey = envResolver(config.huggingface.api_key_env);
			this.timeoutMs = config.huggingface.timeout_ms;
		} else if (config.runtime === "custom_http") {
			this.name = `http:${config.custom_http.endpoint || "<unset>"}`;
			this.endpoint = config.custom_http.endpoint;
			this.apiKey = config.custom_http.api_key_env
				? envResolver(config.custom_http.api_key_env)
				: undefined;
			this.timeoutMs = config.custom_http.timeout_ms;
		} else {
			this.name = "http:<disabled>";
			this.endpoint = "";
			this.apiKey = undefined;
			this.timeoutMs = 0;
		}
	}

	async ready(): Promise<boolean> {
		if (!this.endpoint) return false;
		// Lightest possible probe — an empty input still exercises auth + routing
		// and costs ~nothing on HF's inference API. Any 2xx counts as ready.
		const r = await this.rawScan("", undefined);
		return r !== undefined;
	}

	async scan(req: ScanRequest): Promise<ScanFinding[]> {
		const raw = await this.rawScan(req.text, req.signal);
		if (!raw) return [];
		return raw.map((r) => ({
			label: r.entity_group,
			start: r.start,
			end: r.end,
			text: r.word,
			score: r.score,
			source: req.source,
		}));
	}

	async shutdown(): Promise<void> {
		// Nothing to clean up — stateless.
	}

	private async rawScan(
		text: string,
		callerSignal: AbortSignal | undefined,
	): Promise<HfTokenClassificationEntity[] | undefined> {
		if (!this.endpoint) return undefined;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const abortSignal = mergeSignals(callerSignal, controller.signal);

		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
			const resp = await this.fetchFn(this.endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ inputs: text }),
				signal: abortSignal,
			});
			if (!resp.ok) return undefined;
			const data: unknown = await resp.json();
			return parseHfResponse(data);
		} catch {
			return undefined; // fail-open on any network/parse/abort error
		} finally {
			clearTimeout(timer);
		}
	}
}

// ===========================================
// Helpers
// ===========================================

function defaultEnvResolver(varName: string): string | undefined {
	return varName ? process.env[varName] : undefined;
}

/** Combine a caller-supplied AbortSignal with our timeout signal into one
 *  signal that aborts when either does. Uses `AbortSignal.any` on Node 22+
 *  and falls back to a hand-rolled listener for older runtimes. */
function mergeSignals(
	caller: AbortSignal | undefined,
	timeout: AbortSignal,
): AbortSignal {
	if (!caller) return timeout;
	if (typeof AbortSignal.any === "function") {
		return AbortSignal.any([caller, timeout]);
	}
	const ctrl = new AbortController();
	const forward = () => ctrl.abort();
	caller.addEventListener("abort", forward, { once: true });
	timeout.addEventListener("abort", forward, { once: true });
	return ctrl.signal;
}

function parseHfResponse(data: unknown): HfTokenClassificationEntity[] | undefined {
	if (!Array.isArray(data)) return undefined;
	const out: HfTokenClassificationEntity[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const obj = item as JsonObject;
		if (
			typeof obj.entity_group !== "string" ||
			typeof obj.score !== "number" ||
			typeof obj.word !== "string" ||
			typeof obj.start !== "number" ||
			typeof obj.end !== "number"
		) {
			continue;
		}
		out.push({
			entity_group: obj.entity_group,
			score: obj.score,
			word: obj.word,
			start: obj.start,
			end: obj.end,
		});
	}
	return out;
}
