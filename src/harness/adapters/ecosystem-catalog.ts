import catalog from "./hook-support-catalog.json" with { type: "json" };
import type { HookRuntimeIdentity } from "./hook-contract.js";

/** Documented inventory shared by diagnostics and adapter planning. Never a runtime certificate. */
export const ecosystemCatalog = catalog;

export interface EcosystemProfile {
    runtime: HookRuntimeIdentity;
    declaration: (typeof catalog.surfaces)[number] | null;
    runtimeCertification: "unmeasured";
}

/** A version string alone does not certify a declaration for that installation. */
export function resolveEcosystemProfile(runtime: HookRuntimeIdentity): EcosystemProfile {
    const aliases: Record<string, string> = { cursor: "cursor-ide", opencode: "opencode-v1" };
    return {
        runtime,
        declaration: catalog.surfaces.find(profile => profile.id === (aliases[runtime.provider] ?? runtime.provider)) ?? null,
        runtimeCertification: "unmeasured" as const,
    };
}
