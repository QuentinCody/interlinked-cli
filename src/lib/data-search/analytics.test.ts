import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceAnalyticsSql, exportEvidenceAnalytics, queryR2Sql } from "./analytics.js";
import { generateCorpus } from "./snapshot.js";

describe("R2 SQL contract adapter", () => {
    const scope = { tenant: "tenant-a", project: "project-a", table: "evidence.events" };
    it("binds scope and escapes literals without interpreting text as SQL", () => {
        const sql = evidenceAnalyticsSql(scope, { text: "X'OR", session: "s'1", since: 123, limit: 4, offset: 2 });
        expect(sql).toBe('SELECT DISTINCT "id", "event_ms" FROM "evidence"."events" WHERE "tenant"=\'tenant-a\' AND "project"=\'project-a\' AND "session"=\'s\'\'1\' AND "event_ms">=123 AND strpos("text_ascii_folded",\'x\'\'or\')>0 ORDER BY "event_ms" DESC NULLS LAST, "id" LIMIT 4 OFFSET 2');
    });
    it("rejects foreign scopes, identifier injection and unsupported predicates", () => {
        expect(() => evidenceAnalyticsSql(scope, { tenant: "foreign" })).toThrow("foreign");
        expect(() => evidenceAnalyticsSql({ ...scope, table: "events;DROP TABLE x" }, {})).toThrow("table");
        expect(() => evidenceAnalyticsSql(scope, { file: "src/a.ts" })).toThrow("not implemented");
    });
    it("uses the documented HTTPS API and keeps credentials out of the body", async () => {
        const calls: Array<{ url: string; body: unknown; redirect: unknown }> = [];
        const request: typeof fetch = async (url, options) => {
            calls.push({ url: String(url), body: options?.body, redirect: options?.redirect });
            return Response.json({ result: [] });
        };
        await queryR2Sql({ ...scope, account: "a".repeat(32), bucket: "test-bucket", token: "fixture-token" }, {}, request);
        expect(calls[0]?.url).toBe(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${"a".repeat(32)}/r2-sql/query/test-bucket`);
        expect(calls[0]?.body).not.toContain("fixture-token");
        expect(calls[0]?.redirect).toBe("error");
    });
    it("exports local provenance and folded search text without replacing raw JSONL", async () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-analytics-"));
        const corpus = join(root, "corpus");
        await generateCorpus(corpus, 3);
        const original = readFileSync(join(corpus, "events.jsonl"));
        await exportEvidenceAnalytics(corpus, join(root, "export"));
        const lines = readFileSync(join(root, "export", "analytics.jsonl"), "utf8").trim().split("\n");
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ tenant: "benchmark", project: "synthetic", text_ascii_folded: expect.stringContaining("needle-auth-failure") });
        expect(readFileSync(join(corpus, "events.jsonl"))).toEqual(original);
    });
});
