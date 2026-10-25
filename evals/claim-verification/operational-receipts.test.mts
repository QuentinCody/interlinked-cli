import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { interpretOperationalClaim, verifyOperationalClaim, type OperationalReceipt } from "./operational-receipts.mjs";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const persist = (name: string, value: unknown) => {
    const directory = process.env.CLAIM_RECEIPT_OUTPUT;
    if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
};
const scope = { receiptId: "r1", cwd: "/fixture", sourceIdentity: "source-v1", selection: ["fixture.ts"] };
const base: OperationalReceipt = { id: "r1", cwd: scope.cwd, sourceIdentity: scope.sourceIdentity, selection: scope.selection,
    completion: "completed", exitCode: 0, signal: null, directInvocation: true, runner: "command", outputComplete: true,
    stdout: "", stderr: "", sourceUnchanged: true };

test("real nonzero command termination supports completed, not clean", () => {
    const script = "console.log('finished'); process.exitCode = 3";
    const identity = { receiptId: "node-completion-1", cwd: process.cwd(), sourceIdentity: hash(script), selection: [process.execPath, "-e", script] };
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const receipt = { ...base, ...identity, id: identity.receiptId, exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
    const claim = interpretOperationalClaim("Command completed.", identity)!;
    const verdict = verifyOperationalClaim(claim, receipt);
    assert.equal(verdict.status, "supported");
    assert.equal(verifyOperationalClaim(claim, { ...receipt, completion: "running", exitCode: null }).status, "not_assessable");
    persist("command-completed", { invocation: [process.execPath, "-e", "console.log('finished'); process.exitCode = 3"], receipt, claim, verdict });
});

test("real file write needs a write observation and hash, not an existing-file listing", () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-receipt-"));
    try {
        const path = join(directory, "written.txt"); const content = "verified write\n";
        writeFileSync(path, content, { flag: "wx" });
        const identity = { receiptId: "write-1", cwd: process.cwd(), sourceIdentity: hash(content), selection: [path] };
        const receipt: OperationalReceipt = { ...base, ...identity, id: identity.receiptId, fileWrite: { path, observedByCall: identity.receiptId, afterSha256: hash(readFileSync(path, "utf8")), bytesWritten: Buffer.byteLength(content) } };
        const claim = interpretOperationalClaim(`File \`${path}\` was written.`, identity)!;
        const verdict = verifyOperationalClaim(claim, receipt); assert.equal(verdict.status, "supported");
        const existingOnly = { ...receipt }; delete existingOnly.fileWrite;
        assert.equal(verifyOperationalClaim(claim, existingOnly).status, "not_assessable");
        assert.equal(verifyOperationalClaim(claim, { ...receipt, fileWrite: { ...receipt.fileWrite!, observedByCall: "other" } }).status, "not_assessable");
        persist("file-written", { receipt, claim, verdict });
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real TypeScript clean and failed runs retain direct runner exit and exact source scope", () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-typecheck-"));
    try {
        const path = join(directory, "fixture.ts");
        for (const [name, content, expected] of [["clean", "export const answer: number = 42;", "supported"],
            ["failed", "export const answer: number = 'wrong';", "contradicted"]] as const) {
            writeFileSync(path, content);
            const args = ["--ignoreConfig", "--noEmit", "--skipLibCheck", "--types", "node", "--target", "es2022", path];
            const result = spawnSync(resolve("node_modules/.bin/tsgo"), args, { encoding: "utf8", timeout: 30_000 });
            assert.ifError(result.error);
            const identity = { receiptId: `ts-${name}`, cwd: process.cwd(), sourceIdentity: hash(content), selection: [path] };
            const receipt: OperationalReceipt = { ...base, ...identity, id: identity.receiptId, runner: "typescript", exitCode: result.status,
                signal: result.signal, stdout: result.stdout, stderr: result.stderr, sourceUnchanged: hash(readFileSync(path, "utf8")) === hash(content) };
            const claim = interpretOperationalClaim("Typecheck completed cleanly.", identity)!;
            const verdict = verifyOperationalClaim(claim, receipt); assert.equal(verdict.status, expected);
            assert.equal(verifyOperationalClaim(claim, { ...receipt, directInvocation: false, exitCode: 0 }).status, "not_assessable");
            assert.equal(verifyOperationalClaim(claim, { ...receipt, sourceIdentity: "other" }).status, "unsupported");
            persist(`typecheck-${name}`, { invocation: [resolve("node_modules/.bin/tsgo"), ...args], source: content, receipt, claim, verdict });
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("scope, cancellation and unsupported wording cannot silently become success", () => {
    assert.equal(interpretOperationalClaim("Everything is good now.", scope), null);
    const claim = interpretOperationalClaim("Command completed.", scope)!;
    assert.equal(verifyOperationalClaim(claim, { ...base, completion: "cancelled", signal: "SIGTERM", exitCode: null }).status, "contradicted");
    assert.equal(verifyOperationalClaim(claim, { ...base, id: "other" }).status, "not_assessable");
});
