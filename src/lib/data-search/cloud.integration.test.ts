import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCorpus } from "./snapshot.js";
import { evidenceHash, scanCorpus } from "./corpus.js";
import { buildSegments, type SegmentManifest } from "./segments.js";
import { DirectoryEvidenceStore } from "./object-store.js";
import { publishCloudEvidence, queryCloudEvidence } from "./cloud-client.js";

const endpoint = process.env.INTERLINKED_EVIDENCE_TEST_ENDPOINT;
const token = "benchmark-local-only";
const target = { endpoint: endpoint ?? "http://127.0.0.1:8789", token, project: "synthetic" };
const headers = { authorization: `Bearer ${token}`, "x-evidence-project": target.project };
let root: string;
let store: DirectoryEvidenceStore;
let manifest: SegmentManifest;
let id: string;

describe.skipIf(!endpoint)("real local Worker/R2/SQLite Durable Object evidence path", () => {
    beforeAll(async () => {
        root = join(mkdtempSync(join(tmpdir(), "interlinked-cloud-evidence-")), "corpus");
        await generateCorpus(root, 320, 512);
        store = new DirectoryEvidenceStore(join(root, "objects"));
        manifest = await buildSegments(root, store, 1024);
        id = await publishCloudEvidence(manifest, store, target);
    }, 60_000);
    it("queries across catalog partitions with exact IDs and ordered pages", async () => {
        const query = { text: "needle-auth-failure", limit: 2, offset: 1 };
        const expected = await scanCorpus(root, query);
        const actual = await queryCloudEvidence(target, id, query);
        expect(actual.ids).toEqual(expected.ids);
        expect(actual.rows.map((row) => row.id)).toEqual(expected.rows.map((row) => row.id));
        expect(actual.coverage.complete).toBe(true);
    });
    it("replays immutable objects and catalogs idempotently", async () => {
        expect(await publishCloudEvidence(manifest, store, target)).toBe(id);
        expect((await queryCloudEvidence(target, id, {})).total).toBe(320);
    }, 60_000);
    it("retrieves original compressed bytes using the returned object locator", async () => {
        const answer = await queryCloudEvidence(target, id, { call: "call-97" });
        const key = answer.rows[0]?.object;
        expect(key).toBeTruthy();
        const response = await fetch(`${target.endpoint}/objects/${key}`, { headers });
        expect(response.status).toBe(200);
        expect(evidenceHash(new Uint8Array(await response.arrayBuffer()))).toBe(key?.split("/").at(-1)?.replace(".jsonl.gz", ""));
    });
    it("denies missing credentials and cross-tenant queries", async () => {
        expect((await fetch(`${target.endpoint}/query/${id}`, { method: "POST", body: "{}" })).status).toBe(401);
        await expect(queryCloudEvidence(target, id, { tenant: "foreign" })).rejects.toThrow("403");
        await expect(queryCloudEvidence({ ...target, project: "foreign" }, id, {})).rejects.toThrow("404");
    });
    it("rejects malformed queries and forged pruning metadata", async () => {
        const response = await fetch(`${target.endpoint}/query/${id}`, { method: "POST", headers, body: "{" });
        expect(response.status).toBe(400);
        const forged = { ...manifest, segments: manifest.segments.map((segment) => ({ ...segment, sessions: [] })) };
        const upload = await fetch(`${target.endpoint}/manifests`, { method: "PUT", headers, body: JSON.stringify(forged) });
        expect(upload.status).toBe(400);
        expect(await upload.text()).toContain("synopsis mismatch");
    });
    it("refuses real-log uploads even to the local evaluation service", async () => {
        await expect(publishCloudEvidence({ ...manifest, corpus: { ...manifest.corpus, kind: "claude-snapshot" } }, store, target)).rejects.toThrow("synthetic");
    });
});
