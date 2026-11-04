import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGED_PUSH_BOOTSTRAP, MANAGED_PUSH_LAUNCHER } from "./managed-push-launcher.js";

describe("managed push bootstrap", () => {
    it("refuses a modified manifest before executing its captured launcher", () => {
        const root = mkdtempSync(join(tmpdir(), "managed-bootstrap-test-"));
        try {
            const manifest = join(root, "manifest.json");
            writeFileSync(manifest, JSON.stringify({ launcher: "process.stdout.write('unsafe')" }), { mode: 0o444 });
            const result = spawnSync(process.execPath, ["--input-type=module", "--eval", MANAGED_PUSH_BOOTSTRAP, manifest, "0".repeat(64), "", ""], { encoding: "utf8" });
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain("manifest changed");
            expect(result.stdout).not.toContain("unsafe");
            expect(MANAGED_PUSH_LAUNCHER).toContain("core.hooksPath=");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
