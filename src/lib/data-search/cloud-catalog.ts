import { evidenceHash } from "./corpus.js";
import { parseSegmentManifest, segmentMayMatch, type EvidenceSegment } from "./segments.js";
import type { EvidenceQuery } from "./types.js";
import { isJsonObject } from "../json-types.js";

interface CatalogSql { exec(sql: string, ...bindings: Array<string | number | null>): { toArray(): Array<Record<string, unknown>> }; }
interface CatalogState { storage: { sql: CatalogSql; transactionSync<T>(run: () => T): T }; }
export const CATALOG_PARTITION_BYTES = 128 * 1024;

/** One immutable catalog partition per object, capped far below the DO SQLite limit. */
export class EvidenceCatalog {
    constructor(private readonly state: CatalogState) {
        state.storage.sql.exec("CREATE TABLE IF NOT EXISTS catalog(id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
    }
    async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (request.method === "PUT" && path === "/initialize") return this.initialize(await request.text());
        if (request.method === "POST" && path === "/query") return this.query(await request.json());
        return new Response("not found", { status: 404 });
    }
    private initialize(text: string): Response {
        if (Buffer.byteLength(text) > CATALOG_PARTITION_BYTES) return new Response("catalog partition full", { status: 413 });
        parseSegmentManifest(JSON.parse(text));
        return this.state.storage.transactionSync(() => {
            const previous = this.state.storage.sql.exec("SELECT content FROM catalog WHERE id=1").toArray()[0];
            if (previous && previous.content !== text) return new Response("immutable catalog conflict", { status: 409 });
            this.state.storage.sql.exec("INSERT OR IGNORE INTO catalog(id,content) VALUES(1,?)", text);
            return Response.json({ hash: evidenceHash(text), bytes: Buffer.byteLength(text) });
        });
    }
    private query(value: unknown): Response {
        if (!isJsonObject(value)) return new Response("invalid query", { status: 400 });
        const stored = this.state.storage.sql.exec("SELECT content FROM catalog WHERE id=1").toArray()[0];
        if (!stored || typeof stored.content !== "string") return new Response("missing partition", { status: 404 });
        const manifest = parseSegmentManifest(JSON.parse(stored.content));
        if (value.tenant !== manifest.corpus.tenant || value.project !== manifest.corpus.project) return new Response("forbidden", { status: 403 });
        // SAFETY: the public Worker validates the query before dispatch; only synopsis filters run here.
        const query = value as EvidenceQuery;
        return Response.json(manifest.segments.filter((segment) => segmentMayMatch(segment, query)));
    }
}
export function partitionCatalog(segments: EvidenceSegment[], header: string): EvidenceSegment[][] {
    const partitions: EvidenceSegment[][] = [];
    let current: EvidenceSegment[] = [];
    let bytes = Buffer.byteLength(header) + 64;
    for (const segment of segments) {
        const size = Buffer.byteLength(JSON.stringify(segment)) + 1;
        if (size + Buffer.byteLength(header) + 64 > CATALOG_PARTITION_BYTES) throw new Error("segment descriptor exceeds catalog partition capacity");
        if (bytes + size > CATALOG_PARTITION_BYTES) { partitions.push(current); current = []; bytes = Buffer.byteLength(header) + 64; }
        current.push(segment); bytes += size;
    }
    if (current.length) partitions.push(current);
    return partitions;
}
