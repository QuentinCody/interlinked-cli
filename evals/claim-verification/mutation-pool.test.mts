import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { copyClosure, enumeratePool, runBoundedProcess } from "./mutation-pool.mjs";

test("mutation sites exclude comments, imports and type literals while including conventional operators", () => {
    const code = 'import x from "dependency"; type T = "allowed"; // 42\nexport function f(n:number) { if(n <= 3) return "ok"; return false; }';
    const pool = enumeratePool(code);
    assert.ok(pool.length > 5);
    assert.ok(pool.some(m => m.before === "<=" && m.after === "<"));
    assert.ok(pool.some(m => m.before === '"ok"' && m.after === '""'));
    assert.ok(pool.every(m => !m.before.includes("dependency") && m.before !== '"allowed"' && m.before !== "42"));
    assert.equal(new Set(pool.map(m => m.id)).size, pool.length);
});

test("timed-out mutation processes terminate and preserve captured output", async () => {
    const result = await runBoundedProcess(process.execPath, ["-e", 'console.log("started");setInterval(()=>{},1000)'], 500);
    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /started/);
    assert.equal(result.signal, "SIGKILL");
});

test("isolated dependency copies follow runtime re-exports", () => {
    const fixture = mkdtempSync(join(process.cwd(), "scratch/mutation-closure-"));
    try {
        const entry = join(fixture, "entry.ts"), leaf = join(fixture, "leaf.ts"), out = join(fixture, "copy");
        writeFileSync(entry, 'export { value } from "./leaf.js";');
        writeFileSync(leaf, "export const value = 3;");
        copyClosure(entry, out);
        assert.equal(readFileSync(join(out, relative(process.cwd(), leaf)), "utf8"), "export const value = 3;");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
});
