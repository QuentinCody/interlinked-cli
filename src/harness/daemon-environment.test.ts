import { describe, expect, it } from "vitest";
import { daemonEnvironment } from "./daemon-environment.js";
import { privateConfigPath, restrictedCommand } from "./runtime-policy.js";

describe("detached runtime independence", () => {
    it("drops injected loaders and every disposable scratch pointer", () => {
        const original = { NODE_OPTIONS: "--require /repo/scratch/run/guard.cjs", NODE_PATH: "/tmp/modules",
            TMPDIR: "/repo/scratch/run/tmp", XDG_CACHE_HOME: "/repo/scratch/run/cache", B1_MEASURE_EMBEDDINGS: "1",
            CUSTOM_POINTER: "/repo/scratch/run/policy", PATH: "/usr/bin", HOME: "/home/user",
            INTERLINKED_RUNTIME_POLICY: "local-restricted" };
        expect(daemonEnvironment(original)).toEqual({ PATH: "/usr/bin", HOME: "/home/user", INTERLINKED_RUNTIME_POLICY: "local-restricted" });
        expect(original.NODE_OPTIONS).toContain("--require");
    });
    it("preserves normal runtime settings without a scratch reference", () => {
        expect(daemonEnvironment({ TMPDIR: "/tmp", INTERLINKED_HARNESS_HEAP_MB: "1024" })).toEqual({ TMPDIR: "/tmp", INTERLINKED_HARNESS_HEAP_MB: "1024" });
    });
    it("local policy identifies private config and prohibited commands, not socket helpers", () => {
        expect(privateConfigPath("/repo/.interlinked/config.local.json")).toBe(true);
        expect(privateConfigPath("/repo/.interlinked/guard-rules.local.json")).toBe(false);
        expect(restrictedCommand("/usr/bin/git", ["status"])).toBe(true);
        expect(restrictedCommand("sh", ["-c", "claude -p hello"])).toBe(true);
        expect(restrictedCommand("node", ["dist/harness/server.js"])).toBe(false);
    });
});
