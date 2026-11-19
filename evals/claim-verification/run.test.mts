import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("offline pilot writes measured results and preserves an explicit not-run model status", { timeout: 60_000 }, t => {
    const root = mkdtempSync(join(tmpdir(), "claim-pilot-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dataset = join(root, "turns.jsonl");
    writeFileSync(dataset, JSON.stringify({ id: "s:1", session: "s", final_text: "Tests pass. Build failed.", claims: [], tools: [] }) + "\n");
    const out = join(root, "results");
    execFileSync(process.execPath, ["--import", "tsx", "evals/claim-verification/run.mts", "--dataset", dataset, "--out", out], { timeout: 30_000 });
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    assert.equal(summary.historical.turns, 1);
    assert.equal(summary.historical.sessions, 1);
    assert.equal(summary.historical.legacyCandidates, 0);
    assert.equal(summary.historical.spanCandidates, 2);
    assert.equal(summary.historical.exactSpans, 2);
    assert.equal(summary.jev.status, "not_run");
    assert.equal(summary.datasetSha256, createHash("sha256").update(readFileSync(dataset)).digest("hex"));
});
