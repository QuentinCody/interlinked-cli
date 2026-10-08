import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { embedInputs, embedTexts, withLocalModel } from "./runtime.js";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let text = "";
    for await (const part of request) text += part;
    return text ? JSON.parse(text) : {};
}

it("switches models over HTTP without overlap, caches vectors, and leaves unrelated residents alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "decision-residency-"));
    const loaded = new Set<string>();
    let peak = 0,
        embeddingCalls = 0;
    const embeddingRequests: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
        void body(request)
            .then((input) => {
                let result: unknown = {};
                switch (request.url) {
                    case "/api/tags":
                        result = {
                            models: [
                                { name: "clef", digest: "c1" },
                                { name: "qwen", digest: "e1" },
                                { name: "embeddinggemma-2:740m", digest: "g1" },
                            ],
                        };
                        break;
                    case "/api/ps":
                        result = { models: [...loaded].map((name) => ({ name })) };
                        break;
                    case "/api/generate":
                        loaded.delete(String(input.model));
                        break;
                    case "/api/embed": {
                        loaded.add(String(input.model));
                        embeddingCalls++;
                        embeddingRequests.push(input);
                        const vector =
                            input.model === "embeddinggemma-2:740m"
                                ? Array.from({ length: 768 }, () => 0.5)
                                : [0.3, 0.7];
                        result = { embeddings: (input.input as string[]).map(() => vector) };
                        break;
                    }
                    case "/v1/systemone":
                        loaded.add("clef");
                        result = { model: "clef", answers: {} };
                        break;
                    default:
                        response.statusCode = 404;
                }
                peak = Math.max(peak, loaded.size);
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify(result));
            })
            .catch(() => {
                response.statusCode = 500;
                response.end();
            });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    const config = parseConfig({
        version: 1,
        model: "clef",
        embeddingModel: "qwen",
        ollamaUrl: url,
        url: `${url}/v1`,
    });
    try {
        await withLocalModel(config, "clef", Date.now() + 5000, async (identity) => {
            expect(identity).toBe("clef@c1");
            await fetch(`${url}/v1/systemone`, { method: "POST", body: "{}" });
        });
        const first = await embedTexts(config, ["same input"], Date.now() + 5000, root);
        const cached = await embedTexts(config, ["same input"], Date.now() + 5000, root);
        expect(cached).toEqual(first);
        expect(embeddingCalls).toBe(1);
        const gemma = await embedInputs(
            { ...config, embeddingModel: "embeddinggemma-2:740m" },
            [
                { role: "query", text: "retry payments" },
                { role: "document", title: "retry.ts", text: "function retry() {}" },
            ],
            Date.now() + 5000,
            root,
        );
        expect(gemma.identity).toBe(
            "embeddinggemma-2:740m@g1|embeddinggemma-2-code-retrieval-768d-v1",
        );
        expect(gemma.vectors.map((vector) => vector.length)).toEqual([768, 768]);
        expect(embeddingRequests[1]).toMatchObject({
            model: "embeddinggemma-2:740m",
            options: { num_ctx: 8192 },
            truncate: false,
        });
        expect(embeddingRequests[1]?.input).toEqual([
            "task: code retrieval | query: retry payments",
            "title: retry.ts | text: function retry() {}",
        ]);
        expect(embeddingCalls).toBe(2);
        expect(peak).toBe(1);
        expect([...loaded]).toEqual([]);
        loaded.add("someone-elses-model");
        await expect(embedTexts(config, ["different"], Date.now() + 5000, root)).rejects.toThrow(
            /unrelated/,
        );
        expect([...loaded]).toEqual(["someone-elses-model"]);
        expect(embeddingCalls).toBe(2);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});
