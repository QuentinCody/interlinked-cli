import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCiBase } from "./e2e-ci-base.mjs";

test("CI uses the event's predecessor, failing closed for new refs, force pushes and unavailable history", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-base-"));
    const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=e2e@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
        git("init", "--quiet");
        git("commit", "--allow-empty", "--no-gpg-sign", "-m", "base");
        const base = git("rev-parse", "HEAD");
        git("commit", "--allow-empty", "--no-gpg-sign", "-m", "head");
        const head = git("rev-parse", "HEAD");
        assert.equal(resolveCiBase(root, "push", { before: base }, head), base);
        assert.equal(resolveCiBase(root, "pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } }, head), base);
        assert.throws(() => resolveCiBase(root, "push", { before: "0".repeat(40) }, head), /new ref/);
        assert.throws(() => resolveCiBase(root, "push", { before: "f".repeat(40) }, head), /checkout/);
        assert.throws(() => resolveCiBase(root, "push", { before: head }, base), /ancestor/);
        assert.throws(() => resolveCiBase(root, "workflow_dispatch", {}, head), /Unsupported/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
