import { timingSafeEqual } from "node:crypto";
import { evidenceHash } from "./corpus.js";
import { R2EvidenceStore, type EvidenceR2Bucket } from "./cloud-store.js";
import { partitionCatalog } from "./cloud-catalog.js";
import { MAX_SEGMENT_BYTES, parseSegmentManifest, verifySegmentDescriptor, searchSegments, type EvidenceSegment, type SegmentManifest } from "./segments.js";
import { validateEvidenceQuery } from "./query.js";
import { isJsonObject } from "../json-types.js";
import type { EvidenceQuery } from "./types.js";
export { EvidenceCatalog } from "./cloud-catalog.js";

interface CatalogNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> }; }
interface EvidenceEnvironment { EVIDENCE: EvidenceR2Bucket; CATALOG: CatalogNamespace; AUTH_TOKEN: string; TENANT_ID: string; }
interface CatalogRoot { manifest: SegmentManifest; partitions: string[]; }
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
function authorized(request: Request, env: EvidenceEnvironment): boolean {
    if (!env.AUTH_TOKEN || !env.TENANT_ID) return false;
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${env.AUTH_TOKEN}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function projectScope(request: Request, env: EvidenceEnvironment): { project: string; prefix: string } {
    const project = request.headers.get("x-evidence-project");
    if (!project || project.length > 256) throw new Error("missing or oversized project scope");
    return { project, prefix: `${evidenceHash(env.TENANT_ID)}/${evidenceHash(project)}/` };
}
async function boundedBody(request: Request, limit = MAX_REQUEST_BYTES): Promise<Uint8Array> {
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > limit) throw new Error("request body exceeds budget");
            chunks.push(next.value);
        }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
}
async function uploadObject(request: Request, env: EvidenceEnvironment, key: string, prefix: string): Promise<Response> {
    if (!key.startsWith(prefix) || !/^[a-f0-9]{64}\.jsonl\.gz$/.test(key.slice(prefix.length))) return new Response("forbidden object scope", { status: 403 });
    const bytes = await boundedBody(request, MAX_SEGMENT_BYTES);
    if (`${prefix}${evidenceHash(bytes)}.jsonl.gz` !== key) return new Response("object hash mismatch", { status: 400 });
    await new R2EvidenceStore(env.EVIDENCE).put(key, bytes);
    return Response.json({ key, bytes: bytes.length, hash_verified: true });
}
async function retrieveObject(env: EvidenceEnvironment, key: string, prefix: string): Promise<Response> {
    if (!key.startsWith(prefix) || !/^[a-f0-9]{64}\.jsonl\.gz$/.test(key.slice(prefix.length))) return new Response("forbidden object scope", { status: 403 });
    const bytes = await new R2EvidenceStore(env.EVIDENCE).get(key);
    if (`${prefix}${evidenceHash(bytes)}.jsonl.gz` !== key) throw new Error("object hash mismatch");
    return new Response(Buffer.from(bytes), { headers: { "content-type": "application/gzip", "cache-control": "private, no-store" } });
}
async function uploadManifest(request: Request, env: EvidenceEnvironment, project: string, prefix: string): Promise<Response> {
    const manifest = parseSegmentManifest(JSON.parse(Buffer.from(await boundedBody(request)).toString("utf8")));
    if (manifest.corpus.tenant !== env.TENANT_ID || manifest.corpus.project !== project) return new Response("forbidden manifest scope", { status: 403 });
    const store = new R2EvidenceStore(env.EVIDENCE);
    for (const segment of manifest.segments) await verifySegmentDescriptor(store, manifest, segment);
    const rootManifest = { ...manifest, segments: [] };
    const groups = partitionCatalog(manifest.segments, JSON.stringify(rootManifest));
    const partitions: string[] = [];
    for (const segments of groups) {
        const text = JSON.stringify({ ...manifest, segments });
        const id = `${prefix}${evidenceHash(text)}`;
        const response = await env.CATALOG.get(env.CATALOG.idFromName(id)).fetch(new Request("https://catalog/initialize", { method: "PUT", body: text }));
        if (!response.ok) throw new Error(`catalog initialization failed: ${response.status}`);
        partitions.push(id);
    }
    const root: CatalogRoot = { manifest: rootManifest, partitions };
    const serialized = JSON.stringify(root);
    const id = evidenceHash(serialized);
    await env.EVIDENCE.put(`${prefix}catalog/${id}.json`, serialized, { onlyIf: { etagDoesNotMatch: "*" } });
    return Response.json({ id, partitions: partitions.length, segments: manifest.segments.length });
}
async function queryCatalog(request: Request, env: EvidenceEnvironment, project: string, prefix: string, id: string): Promise<Response> {
    if (!/^[a-f0-9]{64}$/.test(id)) return new Response("invalid catalog ID", { status: 400 });
    const queryValue: unknown = JSON.parse(Buffer.from(await boundedBody(request, 64 * 1024)).toString("utf8"));
    if (!isJsonObject(queryValue)) throw new Error("invalid query");
    // SAFETY: validateEvidenceQuery checks all consumed fields before filtering or dispatch.
    const query = queryValue as EvidenceQuery;
    validateEvidenceQuery(query);
    if (query.tenant !== undefined && query.tenant !== env.TENANT_ID) return new Response("forbidden tenant", { status: 403 });
    if (query.project !== undefined && query.project !== project) return new Response("forbidden project", { status: 403 });
    const rootObject = await env.EVIDENCE.get(`${prefix}catalog/${id}.json`);
    if (!rootObject) return new Response("missing catalog", { status: 404 });
    const serialized = Buffer.from(await rootObject.arrayBuffer()).toString("utf8");
    if (evidenceHash(serialized) !== id) throw new Error("catalog hash mismatch");
    // SAFETY: catalog roots are constructed by uploadManifest and content-hash verified above.
    const root = JSON.parse(serialized) as CatalogRoot;
    const segments: EvidenceSegment[] = [];
    for (const partition of root.partitions) {
        const response = await env.CATALOG.get(env.CATALOG.idFromName(partition)).fetch(new Request("https://catalog/query", {
            method: "POST", body: JSON.stringify({ ...query, tenant: env.TENANT_ID, project }) }));
        if (!response.ok) throw new Error(`catalog query failed: ${response.status}`);
        // SAFETY: descriptors originate in the validated immutable catalog partition.
        segments.push(...await response.json() as EvidenceSegment[]);
    }
    const answer = await searchSegments({ ...root.manifest, segments: segments.slice(0, 1000) }, new R2EvidenceStore(env.EVIDENCE), query);
    if (segments.length > 1000) { answer.coverage.complete = false; answer.coverage.errors.push("query exceeds 1000 candidate segments; narrow the query"); }
    return Response.json({ ...answer, engine: "cloud-r2-do" });
}
export default {
    async fetch(request: Request, env: EvidenceEnvironment): Promise<Response> {
        if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
        try {
            const { project, prefix } = projectScope(request, env);
            const path = new URL(request.url).pathname;
            if (request.method === "GET" && path.startsWith("/objects/")) return await retrieveObject(env, path.slice(9), prefix);
            if (request.method === "PUT" && path.startsWith("/objects/")) return await uploadObject(request, env, path.slice(9), prefix);
            if (request.method === "PUT" && path === "/manifests") return await uploadManifest(request, env, project, prefix);
            if (request.method === "POST" && path.startsWith("/query/")) return await queryCatalog(request, env, project, prefix, path.slice(7));
            return new Response("not found", { status: 404 });
        } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
    },
};
