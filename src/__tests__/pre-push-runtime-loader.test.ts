import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pre-push bounded runtime location", () => {
    it("loads tsx beside the pinned hook even when the check cwd is a different export", () => {
        const root = mkdtempSync(join(tmpdir(), "prepush-loader-test-"));
        try {
            const hook = readFileSync(resolve("scripts/git-hooks/pre-push"), "utf8");
            const bounded = hook.match(/^bounded\(\) \{\n[\s\S]*?^\}/m)?.[0];
            if (!bounded) throw new Error("Missing real bounded pre-push function");
            mkdirSync(join(root, "bin")); mkdirSync(join(root, "export"));
            writeFileSync(join(root, "bin/node"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o755 });
            const script = 'bounded_outcome_file() { printf "%s/outcome" "$RUNTIME"; }\nbounded_verdict() { echo exit; }\nhook_dir="$RUNTIME/scripts/git-hooks"\n' + bounded + '\nbounded npm run typecheck:stable\n';
            const result = spawnSync("bash", ["-c", script], { cwd: join(root, "export"), encoding: "utf8", env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, CAPTURE: join(root, "argv"), RUNTIME: root } });
            expect(result.status).toBe(0);
            const argv = readFileSync(join(root, "argv"), "utf8").trim().split("\n");
            expect(argv[1]).toBe("--import");
            expect(resolve(argv[2] ?? "")).toBe(join(root, "node_modules/tsx/dist/loader.mjs"));
            expect(argv.slice(-3)).toEqual(["npm", "run", "typecheck:stable"]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
