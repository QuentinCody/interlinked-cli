import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, hash, record, text } from "./relation-core.js";
import { SEMANTIC_GRAPH_DIR } from "./types.js";
import { gzipSync, gunzipSync } from "node:zlib";

function digestId(value: string): string { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid artifact digest"); return value; }
export function readRelationJson(path: string): unknown {
    if (statSync(path).size > 64_000_000) throw new Error("relation artifact exceeds read budget");
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
export function writeArtifactFile(path: string, value: unknown): void {
    writeArtifactBytes(path, Buffer.from(`${canonical(value)}\n`));
}
function writeArtifactBytes(path: string, bytes: Buffer): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
        try { linkSync(temporary, path); } catch (error) {
            if (!existsSync(path) || !readFileSync(path).equals(bytes)) throw error;
        }
    } finally { rmSync(temporary, { force: true }); }
}
export function publishArtifact(root: string, value: unknown): string {
    const digest = hash(value);
    writeArtifactFile(join(root, SEMANTIC_GRAPH_DIR, "artifacts", `${digest}.json`), value);
    return digest;
}
export function readArtifact(root: string, digest: string): unknown {
    const value = readRelationJson(join(root, SEMANTIC_GRAPH_DIR, "artifacts", `${digestId(digest)}.json`));
    if (hash(value) !== digest) throw new Error("artifact digest mismatch");
    return value;
}
export function appendClaimEvent(root: string, event: { logicalKey: string; armId: string; measurement: string }): void {
    digestId(event.measurement);
    const path = join(root, SEMANTIC_GRAPH_DIR, "claims.jsonl");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${canonical({ schema: "interlinked.relation-claim-event/1", ...event })}\n`, { mode: 0o600 });
}
export function exportBundle(destination: string, value: unknown, kind: "input" | "result"): void {
    // Embedded plans contain their complete source/packet/policy closure, not mutable paths.
    const digest = hash(value);
    const bytes = Buffer.from(`${canonical(value)}\n`), encoding = bytes.length > 1_000_000 ? "gzip" : "json";
    if (encoding === "gzip") writeArtifactBytes(join(destination, "artifacts", `${digest}.json.gz`), gzipSync(bytes, { level: 9 }));
    else writeArtifactFile(join(destination, "artifacts", `${digest}.json`), value);
    writeArtifactFile(join(destination, "manifest.json"), { schema: "interlinked.relation-bundle/1", kind, digest, encoding, complete: true });
}
export function readBundle(directory: string): unknown {
    const manifest = record(readRelationJson(join(directory, "manifest.json")));
    if (manifest.schema !== "interlinked.relation-bundle/1" || manifest.complete !== true || !["input", "result"].includes(String(manifest.kind))) throw new Error("incomplete relation bundle");
    const digest = digestId(text(manifest.digest));
    if (manifest.encoding !== undefined && manifest.encoding !== "json" && manifest.encoding !== "gzip") throw new Error("unsupported bundle encoding");
    const value = manifest.encoding === "gzip"
        ? JSON.parse(gunzipSync(readFileSync(join(directory, "artifacts", `${digest}.json.gz`)), { maxOutputLength: 64_000_000 }).toString("utf8")) as unknown
        : readRelationJson(join(directory, "artifacts", `${digest}.json`));
    if (hash(value) !== digest) throw new Error("bundle digest mismatch");
    return value;
}
