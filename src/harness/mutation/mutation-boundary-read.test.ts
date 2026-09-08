import { describe, expect, it } from "vitest";
import { buildMutationCloudV3Config } from "./mutation-cloud-v3-config.js";
import { openNodeSqlite } from "./mutation-journal-driver.js";
import { readJournalJob } from "./mutation-journal-read.js";

describe("mutation persisted boundary validation", () => {
    it("rejects malformed key fields even when the config builder is called directly", () => {
        expect(() => buildMutationCloudV3Config({
            server_authority: {}, key_registry: { key: { public_key_pem: 42, purposes: ["result"] } },
        }, "/repo", false)).toThrow("key registry has invalid field types");
    });

    it("rejects an invalid persisted job status from a damaged database", () => {
        const db = openNodeSqlite(":memory:");
        try {
            db.exec("CREATE TABLE mutation_jobs(job_id TEXT, status TEXT, dead_lettered_at_ms INTEGER)");
            db.exec("INSERT INTO mutation_jobs VALUES ('job', 'unexpected-status', NULL)");
            expect(() => readJournalJob(db, "job")).toThrow("mutation journal job has invalid status");
        } finally {
            db.close();
        }
    });
});
