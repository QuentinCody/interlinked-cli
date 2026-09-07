import { isJsonObject } from "../json-types.js";
import type { EvidenceAnswer, EvidenceQuery } from "./types.js";
import type { EvidenceObjectStore, SegmentManifest } from "./segments.js";

export interface CloudEvidenceTarget { endpoint: string; token: string; project: string; }
function targetUrl(target: CloudEvidenceTarget, path: string): URL {
    const base = new URL(target.endpoint);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
    if (!local && base.protocol !== "https:") throw new Error("remote evidence endpoint requires HTTPS");
    return new URL(path, base);
}
async function cloudRequest(target: CloudEvidenceTarget, path: string, method: string, body: string | Uint8Array): Promise<unknown> {
    const response = await fetch(targetUrl(target, path), { method, body: typeof body === "string" ? body : Buffer.from(body),
        headers: { authorization: `Bearer ${target.token}`, "x-evidence-project": target.project, "content-type": "application/json" },
        redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`evidence service returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.json();
}
export async function publishCloudEvidence(manifest: SegmentManifest, store: EvidenceObjectStore, target: CloudEvidenceTarget): Promise<string> {
    if (manifest.corpus.kind !== "synthetic") throw new Error("cloud evaluation only uploads synthetic corpora; retained user logs stay local");
    for (const segment of manifest.segments) await cloudRequest(target, `/objects/${segment.key}`, "PUT", await store.get(segment.key));
    const response = await cloudRequest(target, "/manifests", "PUT", JSON.stringify(manifest));
    if (!isJsonObject(response) || typeof response.id !== "string") throw new Error("invalid cloud catalog receipt");
    return response.id;
}
export async function queryCloudEvidence(target: CloudEvidenceTarget, id: string, query: EvidenceQuery): Promise<EvidenceAnswer> {
    const response = await cloudRequest(target, `/query/${id}`, "POST", JSON.stringify(query));
    if (!isJsonObject(response) || !Array.isArray(response.ids) || !Array.isArray(response.rows) || !isJsonObject(response.coverage)) throw new Error("invalid cloud query response");
    // SAFETY: the pinned benchmark Worker returns the shared EvidenceAnswer contract.
    return response as unknown as EvidenceAnswer;
}
