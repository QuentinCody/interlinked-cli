import { createHash, randomUUID } from "node:crypto";

// Replaced by the atomic build from its complete input fingerprint. The literal
// travels with immutable JS chunks, including in npm packages without a lockfile.
declare const __INTERLINKED_EVIDENCE_BUILD__: string | undefined;
const build = typeof __INTERLINKED_EVIDENCE_BUILD__ === "string" ? __INTERLINKED_EVIDENCE_BUILD__ : undefined;
const identity = build && /^[a-f0-9]{64}$/.test(build)
    ? "build:" + createHash("sha256").update(JSON.stringify([build, process.version, process.platform, process.arch])).digest("hex")
    : "source-runtime:" + randomUUID();

/** No filesystem access, including on ordinary CLI startup. Source mode remains explicitly unqualified across processes. */
export function evidenceRuntimeIdentity(): string { return identity; }
