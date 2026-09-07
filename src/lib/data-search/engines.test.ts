import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCorpus, gzipCorpus, createPrivateDirectory, writeCorpusManifest } from "./snapshot.js";
import { corpusRecords, evidenceHash, readCorpus, readCorpusEvidence, scanCorpus, verifyCorpus } from "./corpus.js";
import { buildCompactIndex, directoryBytes, searchBoundedIndex, searchCompactIndex } from "./sqlite.js";
import { buildLegacyIndex, searchLegacyIndex } from "./legacy.js";
import { buildSegments, readSegment, searchSegments, type SegmentManifest } from "./segments.js";
import { DirectoryEvidenceStore } from "./object-store.js";
import type { EvidenceQuery, EvidenceRecord } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "interlinked-evidence-engines-"));
const corpus = join(root, "corpus");
const compressed = join(root, "gzip");
const compact = join(root, "compact");
const bounded = join(root, "bounded");
const legacy = join(root, "legacy");
const store = new DirectoryEvidenceStore(join(root, "objects"));
let manifest: SegmentManifest;

beforeAll(async () => {
    await generateCorpus(corpus, 200, 512);
    await gzipCorpus(corpus, compressed);
    await buildCompactIndex(corpus, compact);
    await buildCompactIndex(corpus, bounded, { diskBudget: 256 * 1024 });
    await buildLegacyIndex(corpus, legacy);
    manifest = await buildSegments(corpus, store, 4096);
});

describe("equivalent evidence engines", () => {
    const queries: EvidenceQuery[] = [
        {}, { text: "needle-auth" }, { text: "NEEDLE failure" }, { text: "café 日本語" },
        { session: "session-17" }, { provider: "claude", decision: "fail" },
        { file: "src/module-3.ts", check: "typescript" }, { call: "call-43" },
        { since: 1_750_000_100_000, until: 1_750_000_100_000 },
        { text: "does-not-exist" }, { tenant: "another-tenant" }, { project: "another-project" },
        { limit: 3, offset: 4 }, { text: "%' OR 1=1 --" },
    ];
    it.each(queries)("returns the same complete IDs and pagination for %j", async (query) => {
        const expected = await scanCorpus(corpus, query);
        const answers = [await scanCorpus(compressed, query), searchCompactIndex(compact, query),
            searchLegacyIndex(legacy, query), await searchBoundedIndex(bounded, corpus, query), await searchSegments(manifest, store, query)];
        for (const answer of answers) {
            expect(answer.coverage.complete, `${answer.engine}: ${answer.coverage.errors}`).toBe(true);
            expect(answer.ids, answer.engine).toEqual(expected.ids);
            expect(answer.rows.map((row) => row.id), answer.engine).toEqual(expected.rows.map((row) => row.id));
        }
    });
    it("matches an independent expected failure census", async () => {
        const result = await scanCorpus(corpus, { text: "needle-auth-failure", limit: 100 });
        expect(result.total).toBe(3);
        expect(result.rows.map((row) => row.call)).toEqual(["call-194", "call-97", "call-0"]);
    });
    it("bounds database allocation and declares incomplete index coverage", () => {
        expect(directoryBytes(bounded)).toBeLessThanOrEqual(256 * 1024);
        expect(searchCompactIndex(bounded, {}).coverage.complete).toBe(false);
    });
    it("verifies original bytes from plain and compressed files", async () => {
        for (const directory of [corpus, compressed]) {
            const result = await scanCorpus(directory, { call: "call-43" });
            const row = result.rows[0];
            expect(row).toBeDefined();
            if (!row) throw new Error("missing evidence");
            expect(evidenceHash(await readCorpusEvidence(directory, row))).toBe(row.hash);
            await expect(readCorpusEvidence(directory, { ...row, hash: "0".repeat(64) })).rejects.toThrow();
        }
    });
    it("replays the same input without duplicate index rows", async () => {
        const before = searchCompactIndex(compact, {}).ids;
        const receipt = await buildCompactIndex(corpus, compact, { resume: true });
        expect(receipt.indexed).toBe(200);
        expect(searchCompactIndex(compact, {}).ids).toEqual(before);
    });
    it("preserves queryability when compressing an already compressed corpus", async () => {
        const output = join(mkdtempSync(join(tmpdir(), "interlinked-gzip-replay-")), "gzip");
        await gzipCorpus(compressed, output);
        expect((await scanCorpus(output, {})).ids).toEqual((await scanCorpus(corpus, {})).ids);
    });
    it("publishes multiple bounded segments and prunes by time", async () => {
        expect(manifest.segments.length).toBeGreaterThan(1);
        const result = await searchSegments(manifest, store, { since: 1_750_000_199_000 });
        expect(result.rows.map((row) => row.call)).toEqual(["call-199"]);
        expect(result.coverage.files).toBeLessThan(manifest.segments.length);
    });
    it("refuses foreign-tenant object references", async () => {
        const segment = manifest.segments[0];
        if (!segment) throw new Error("missing segment");
        await expect(readSegment(store, { ...manifest, corpus: { ...manifest.corpus, tenant: "foreign" } }, segment)).rejects.toThrow("boundary");
    });
    it("retains corrupt objects and reports the hash failure", async () => {
        const segment = manifest.segments[0];
        if (!segment) throw new Error("missing segment");
        const corruptStore = { put: store.put.bind(store), get: async () => new Uint8Array([1, 2, 3]) };
        await expect(readSegment(corruptStore, manifest, segment)).rejects.toThrow("hash mismatch");
    });
});

describe("native transcript and coverage fidelity", () => {
    it("keeps raw native bytes while exposing provider, model and actor", async () => {
        const directory = join(root, "native");
        createPrivateDirectory(directory);
        const raw = JSON.stringify({ type: "assistant", uuid: "u1", sessionId: "s1", agentId: "child-1", timestamp: "2026-01-01T00:00:00Z",
            message: { model: "claude-test", content: [{ type: "text", text: "exact native message" }] } });
        const bytes = `${raw}\n`;
        writeFileSync(join(directory, "native.jsonl"), bytes);
        writeCorpusManifest(directory, { ...readCorpus(corpus), kind: "claude-snapshot",
            files: [{ path: "native.jsonl", source: "native-claude", bytes: Buffer.byteLength(bytes), sha256: evidenceHash(bytes), records: 1, native: true }] });
        const answer = await scanCorpus(directory, { provider: "claude", actor: "child-1", model: "claude-test" });
        expect(answer.total).toBe(1);
        const row = answer.rows[0];
        if (!row) throw new Error("missing native result");
        expect(await readCorpusEvidence(directory, row)).toBe(raw);
    });
    it("does not interpret malformed or partial lines as an empty clean corpus", async () => {
        const directory = join(root, "bad");
        createPrivateDirectory(directory);
        const bytes = 'not-json\n{"partial":';
        writeFileSync(join(directory, "bad.jsonl"), bytes);
        writeCorpusManifest(directory, { ...readCorpus(corpus), files: [{ path: "bad.jsonl", source: "tests", bytes: bytes.length, sha256: evidenceHash(bytes), records: 2, native: false }] });
        const result = await scanCorpus(directory, {});
        expect(result.coverage).toMatchObject({ complete: false, malformed: 1, incomplete: 1 });
    });
    it("detects source modifications even when byte length is unchanged", async () => {
        const directory = join(root, "changed");
        await generateCorpus(directory, 1);
        const path = join(directory, "events.jsonl");
        writeFileSync(path, readFileSync(path, "utf8").replace("needle", "NEEDLE"));
        await expect(verifyCorpus(directory)).rejects.toThrow("hash mismatch");
    });
    it("rejects invalid pagination without scanning", async () => {
        await expect(scanCorpus(corpus, { offset: -1 })).rejects.toThrow("offset");
        expect(() => searchCompactIndex(compact, { limit: 1001 })).toThrow("limit");
    });
    it("includes undated records without a time bound and excludes them with one", async () => {
        const { matchesEvidence } = await import("./query.js");
        let sample: EvidenceRecord | undefined;
        for await (const row of corpusRecords(corpus)) { sample = row; break; }
        if (!sample) throw new Error("missing sample");
        const undated = { ...sample, time: null };
        expect(matchesEvidence(undated, {})).toBe(true);
        expect(matchesEvidence(undated, { since: 0 })).toBe(false);
    });
});
