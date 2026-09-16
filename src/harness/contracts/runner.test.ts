import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { contractDigest } from "./paths.js";
import { runContracts } from "./runner.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(argv: string[], expected: unknown) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "contract-run-"))); roots.push(root);
    mkdirSync(join(root, ".interlinked")); writeFileSync(join(root, "spec.md"), "An exact observable example.");
    const row = { id: "example", description: "exact example", source: { kind: "example", path: "spec.md", sha256: contractDigest("An exact observable example."), quote: "exact observable" }, inputs: [], runner: { kind: "process", argv }, expect: expected };
    writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [row] }));
    return { root, row };
}
it("compares exact output, does not normalize strings and distinguishes missing tools", async () => {
    const { root } = project([process.execPath, "-e", "console.log(JSON.stringify({value:'01'}))"], { json: { value: "1" } });
    expect((await runContracts(root, { timeoutMs: 3000 })).cases[0]?.state).toBe("failed");
    const absent = project(["interlinked-no-such-runner"], { exitCode: 0 });
    expect((await runContracts(absent.root, { timeoutMs: 3000 })).cases[0]?.state).toBe("unavailable");
});
it("executes Python and JavaScript through the same observable contract", async () => {
    for (const argv of [["python3", "-c", "print('portable')"], [process.execPath, "-e", "console.log('portable')"]]) {
        const { root } = project(argv, { stdout: "portable\n", exitCode: 0 });
        expect((await runContracts(root, { timeoutMs: 3000 })).cases[0]?.state).toBe("passed");
    }
});
it("keeps a timeout unmeasured and refuses stale requirement evidence", async () => {
    const { root } = project([process.execPath, "-e", "setTimeout(() => {}, 10000)"], { exitCode: 0 });
    expect((await runContracts(root, { timeoutMs: 100 })).cases[0]?.state).toBe("unavailable");
    writeFileSync(join(root, "spec.md"), "Changed");
    expect((await runContracts(root, { timeoutMs: 1000 })).cases[0]?.state).toBe("stale");
});
it("checks HTTP observations without following redirects", async () => {
    const server = createServer((_req, res) => { res.writeHead(302, { location: "http://example.com", "content-type": "application/json" }); res.end('{"ok":true}'); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
        const { root, row } = project([], {});
        writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [{ ...row, runner: { kind: "http", url: `http://127.0.0.1:${address.port}`, method: "GET" }, expect: { status: 302, json: { ok: true } } }] }));
        expect((await runContracts(root, { timeoutMs: 2000 })).cases[0]?.state).toBe("passed");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("runs retained old expectations against the new implementation", async () => {
    const { root, row } = project([process.execPath, "-e", "console.log('new')"], { stdout: "new\n" });
    writeFileSync(join(root, "previous.json"), JSON.stringify({ version: 1, cases: [{ ...row, expect: { stdout: "old\n" } }] }));
    const report = await runContracts(root, { timeoutMs: 3000, previous: "previous.json" });
    expect(report.cases.map(item => item.state)).toEqual(["passed", "failed"]);
    expect(report.cases[1]?.contract.expect.stdout).toBe("old\n");
    expect(report.reuse).toBe("none-external-state-unsealed");
});

it("preserves completed cases when a later case times out", async () => {
    const { root, row } = project([process.execPath, "-e", "console.log('ok')"], { stdout: "ok\n" });
    writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [row, { ...row, id: "slow", runner: { kind: "process", argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"] } }] }));
    const report = await runContracts(root, { timeoutMs: 300 });
    expect(report.cases.map(item => item.state)).toEqual(["passed", "unavailable"]);
});

it("copies declared UTF-8 fixtures and leaves original inputs unchanged", async () => {
    const { root, row } = project([process.execPath, "main.cjs"], { stdout: "seed\n", files: { "output.txt": "seed" } });
    writeFileSync(join(root, "main.cjs"), "const fs = require('node:fs'); const input = fs.readFileSync('input.txt', 'utf8'); console.log(input); fs.writeFileSync('output.txt', input);");
    writeFileSync(join(root, "input.txt"), "seed");
    writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [{ ...row, inputs: ["main.cjs", "input.txt"] }] }));
    expect((await runContracts(root, { timeoutMs: 3000 })).cases[0]?.state).toBe("passed");
});
