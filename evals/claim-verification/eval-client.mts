import { JevClient, type JevFetch } from "../../src/harness/jev/client.js";

interface Options {
    apiKey: string; save: (name: string, value: unknown) => void; fetchImpl?: JevFetch; maxSpendUsd?: number;
}

/** Evaluation-only request ledger; failures with missing billing remain unknown. */
export function createLoggedClient(options: Options): JevClient {
    let index = 0;
    return new JevClient({ apiKey: options.apiKey, config: { model: "jev-1.13.0", timeout_ms: 60_000, max_spend_usd: options.maxSpendUsd ?? 1 },
        fetchImpl: async (url, init) => {
            const call = index++; const startedAt = new Date().toISOString(); const start = performance.now();
            const request = JSON.parse(String(init.body));
            const headers = new Headers(init.headers); headers.set("TypeSafe-Danger-Zone-Long-Context", "true");
            try {
                const response = await (options.fetchImpl ?? fetch)(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) });
                const raw = await response.text();
                let parsed: { usage?: { input_tokens?: number }; model?: string } | null = null;
                try { parsed = JSON.parse(raw); } catch { /* Raw response is retained. */ }
                const tokens = parsed?.usage?.input_tokens;
                const measured = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0;
                options.save(`call-${call}.json`, { startedAt, latencyMs: performance.now() - start, request,
                    httpStatus: response.status, rawResponse: raw, modelReturned: parsed?.model ?? null,
                    inputTokens: measured ? tokens : null, estimatedUsd: measured ? tokens * 0.042 / 1_000_000 : null,
                    costUnknown: !measured, longContext: true });
                return new Response(raw, { status: response.status, headers: response.headers });
            } catch (error) {
                options.save(`call-${call}.json`, { startedAt, latencyMs: performance.now() - start, request,
                    error: error instanceof Error ? error.name : "unknown", estimatedUsd: null, costUnknown: true });
                throw error;
            }
        } });
}
