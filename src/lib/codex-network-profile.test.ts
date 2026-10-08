import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexNetworkProfile, installCodexNetworkProfile } from "./codex-network-profile.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "network-profile-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const endpoints = ["http://127.0.0.1:11434", "https://api.typesafe.ai"];

describe("reusable Codex permissions", () => {
    it("keeps workspace restrictions and hooks, and activates exact-host filtering", () => {
        const profile = codexNetworkProfile("research", endpoints);
        expect(profile.hosts).toEqual(["127.0.0.1", "api.typesafe.ai"]);
        expect(profile.text).toContain('extends = ":workspace"');
        expect(profile.text).toContain("hooks = true\nnetwork_proxy = true");
        expect(profile.text).toContain('[permissions.research.network]\nenabled = true');
        expect(profile.text).toContain('"127.0.0.1" = "allow"');
        expect(profile.text).not.toContain("danger-full-access");
        expect(profile.text).not.toContain("allow_local_binding = true");
        expect(profile.text).not.toContain("approval_policy");
    });

    it("installs idempotently without changing the base config or hooks", () => {
        const config = join(home, "config.toml");
        writeFileSync(config, "# user configuration\n");
        const first = installCodexNetworkProfile("research", endpoints, home);
        expect(first.changed).toBe(true);
        expect(first.path).toBe(join(home, "research.config.toml"));
        expect(statSync(first.path).mode & 0o777).toBe(0o600);
        expect(installCodexNetworkProfile("research", endpoints, home).changed).toBe(false);
        expect(readFileSync(config, "utf8")).toBe("# user configuration\n");
        expect(readFileSync(first.path, "utf8")).toBe(first.text);
    });

    it("preserves custom profiles and rejects symlinks", () => {
        const path = join(home, "research.config.toml");
        writeFileSync(path, "# custom\n");
        expect(() => installCodexNetworkProfile("research", endpoints, home)).toThrow(/already exists/);
        expect(readFileSync(path, "utf8")).toBe("# custom\n");
        symlinkSync(path, join(home, "linked.config.toml"));
        expect(() => installCodexNetworkProfile("linked", endpoints, home)).toThrow(/already exists/);
    });

    it.each(["../config", "", "bad.name", "bad\nname", "a".repeat(64)])("rejects profile name %j", (name) => {
        expect(() => installCodexNetworkProfile(name, endpoints, home)).toThrow(/Profile names/);
    });
});
