import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startRecorder, runCommand } from "./transport.js";
import { parseConfig } from "./config.js";

it("records exact UTF-8 exchanges without persisting authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "decision-wire-"));
    const upstream = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end('{"model":"pinned","answers":{}}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const config = parseConfig({
        version: 1,
        url: `http://127.0.0.1:${address.port}/v1`,
        ollamaUrl: `http://127.0.0.1:${address.port}`,
    });
    const recorder = await startRecorder(config, root, Date.now() + 5000);
    try {
        const bytes = '{ "state": "λ", "questions": {} }';
        expect(
            (await fetch(`${recorder.url}/systemone`, { method: "POST", body: bytes })).status,
        ).toBe(200);
        const exchange = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), "utf8"));
        expect(exchange.requestBody).toBe(bytes);
        expect(exchange.responseBody).toBe('{"model":"pinned","answers":{}}');
        expect(exchange).not.toHaveProperty("headers");
        expect(
            (await fetch(`${recorder.url}/unexpected`, { method: "POST", body: "x" })).status,
        ).toBe(404);
    } finally {
        await recorder.close();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});

it("terminates a child at its deadline and preserves nonzero outcomes", async () => {
    const result = await runCommand(
        process.execPath,
        ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 10000)"],
        { timeoutMs: 100 },
    );
    expect(result.timedOut).toBe(true);
    const failed = await runCommand(process.execPath, ["-e", "process.exitCode=4"], {
        timeoutMs: 5000,
    });
    expect(failed.exitCode).toBe(4);
});
