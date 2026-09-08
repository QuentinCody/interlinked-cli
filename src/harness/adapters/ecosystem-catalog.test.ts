import { describe, expect, it } from "vitest";
import { ecosystemCatalog, resolveEcosystemProfile } from "./ecosystem-catalog.js";

describe("ecosystem capability inventory", () => {
    it("keeps SDK/protocol inventories distinct from installable adapters", () => {
        expect(ecosystemCatalog.surfaces.length).toBeGreaterThan(40);
        const think = ecosystemCatalog.surfaces.find(profile => profile.label.includes("Think"));
        expect(think?.runtime_verified).toBe(false);
        expect(think?.event_groups.flatMap(group => group.native_names)).toContain("beforeToolCall");
    });
    it("returns explicit unmeasured runtime certification, including unknown versions", () => {
        const profile = resolveEcosystemProfile({ provider: "claude-code", host: "cli", mode: "headless", version: "future" });
        expect(profile.declaration?.id).toBe("claude-code");
        expect(profile.runtimeCertification).toBe("unmeasured");
        expect(resolveEcosystemProfile({ provider: "unlisted", host: "unknown", mode: "unknown" }).declaration).toBeNull();
    });
});
