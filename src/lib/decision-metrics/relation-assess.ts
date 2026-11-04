import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "../../harness/semantic-graph/relation-core.js";
import { parseRelationPlan } from "../../harness/semantic-graph/relation-codec.js";
import { appendClaimEvent, publishArtifact, readArtifact, readRelationJson, writeArtifactFile } from "../../harness/semantic-graph/relation-store.js";
import type { RelationJob, RelationMeasurement, RelationPacket, RelationPlan, RelationRun } from "../../harness/semantic-graph/relation-types.js";
import { RELATION_CONTRACTS, type RelationContract } from "./relation-contracts.js";
import { interpretAnswer, parseAnswer } from "./answers.js";
import { relationBackend, relationRequest, type RelationBackend } from "./relation-engines.js";

export async function assessRelations(root: string, input: RelationPlan, options: { fresh?: boolean; backend?: RelationBackend; onMeasurement?: (measurement: RelationMeasurement) => void } = {}): Promise<RelationRun> {
    const plan = parseRelationPlan(input);
    const backend = options.backend ?? relationBackend(root);
    const measurements: RelationMeasurement[] = [];
    const ledger = new Map<string, { calls: number; usd: number; failures: number; unknownCost: boolean }>();
    for (const job of plan.jobs) {
        const account = ledger.get(job.engine.id) ?? { calls: 0, usd: 0, failures: 0, unknownCost: false };
        ledger.set(job.engine.id, account);
        for (const packet of job.packets) {
            const m = await measureRelationPacket(packet, job, root, options, account, backend);
            measurements.push(m); options.onMeasurement?.(m);
        }
    }
    const body = { schema: "interlinked.relation-run/2" as const, plan, measurements, completedAt: new Date().toISOString(), complete: true };
    const run = { ...body, id: hash(body) };
    publishArtifact(root, run);
    return run;
}

async function measureRelationPacket(packet: RelationPacket, job: RelationJob, root: string, options: { fresh?: boolean; backend?: RelationBackend; onMeasurement?: (measurement: RelationMeasurement) => void; }, account: { calls: number; usd: number; failures: number; unknownCost: boolean; }, backend: RelationBackend) {
    const contract = RELATION_CONTRACTS[packet.kind], contractHash = hash(contract);
    // Conservative refresh: changes outside a selected span may change its
    // semantics. Bind the entire pinned snapshot until selective dependency
    // closure has earned a narrower invalidation policy.
    const fingerprint = hash({ packet: packet.evidenceHash, request: relationRequest(packet), contractHash, engine: job.engine, snapshot: job.snapshot.digest });
    const started = Date.now();
    let m: RelationMeasurement = { schemaVersion: 2, id: randomUUID(), jobId: job.id, packetId: packet.id, logicalKey: packet.logicalKey, armId: job.engine.id, recordKind: packet.kind, populationId: packet.populationId, unit: packet.unit, status: "unassessed", choice: null, raw: null, reason: null, evidenceHash: packet.evidenceHash, fingerprint, contractHash, requestedModel: job.engine.model, servedModel: null, engineIdentity: job.engine.identity, startedAt: new Date(started).toISOString(), durationMs: 0, cached: false, calls: 0, costUsd: null, inputTokens: null, response: null, probabilitySource: "unavailable" };
    m.snapshotDigest = job.snapshot.digest;
    const pointer = join(root, ".interlinked/semantic-graph/relation-cache", `${fingerprint}.json`);
    if (!packet.complete) m.reason = packet.missing.join(",");
    else if (!options.fresh && existsSync(pointer)) {
        m = restoreRelationMeasurement(root, pointer, packet, job, m, contract);
    } else if (account.calls >= job.engine.maxCalls || account.usd >= job.engine.maxUsd || account.failures >= 3 || account.unknownCost) m.reason = "engine budget, unknown spend, or failure circuit exhausted";
    else {
        m = await executeRelationMeasurement(root, backend, job, account, packet, m, contract);
    }
    m.durationMs = Date.now() - started;
    const artifact = publishArtifact(root, m);
    appendClaimEvent(root, { logicalKey: m.logicalKey, armId: m.armId, measurement: artifact });
    if (m.raw && !["failed", "unassessed"].includes(m.status) && !existsSync(pointer)) writeArtifactFile(pointer, artifact);
    return m;
}

async function executeRelationMeasurement(root: string, backend: RelationBackend, job: RelationJob, account: { calls: number; usd: number; failures: number; unknownCost: boolean; }, packet: RelationPacket, m: RelationMeasurement, contract: RelationContract) {
    const folder = join(root, ".interlinked/semantic-graph/requests", randomUUID());
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    try {
        const result = await backend({ ...job.engine, maxCalls: job.engine.maxCalls - account.calls, maxUsd: job.engine.maxUsd - account.usd }, packet, folder);
        account.calls += result.calls;
        if (result.costUsd !== null) account.usd += result.costUsd;
        else if (job.engine.backend !== "ollama" && result.calls) account.unknownCost = true;
        m = { ...m, ...result, response: result.response, status: "failed", reason: result.failure, calls: result.calls };
        // Do not retain backend-only fields as undocumented measurement schema keys.
        delete (m as unknown as Record<string, unknown>).failure;
        if (result.failure || !result.raw) account.failures++;
        else {
            const interpretation = interpretAnswer(contract, parseAnswer(result.raw, contract), job.engine.band);
            m.status = interpretation.status; m.choice = typeof interpretation.value === "string" ? interpretation.value : null; m.reason = interpretation.reason ?? null;
            account.failures = 0;
        }
    } catch (error) {
        account.failures++;
        if (job.engine.backend !== "ollama") account.unknownCost = true;
        m.status = "failed";
        m.reason = error instanceof Error && !error.message.includes("Command failed") ? error.message : "backend execution failed";
        // Exceptions are conservatively counted against call budget; no fake usage/cost.
        m.calls = 1; account.calls++;
    }
    return m;
}

function restoreRelationMeasurement(root: string, pointer: string, packet: RelationPacket, job: RelationJob, m: RelationMeasurement, contract: RelationContract): RelationMeasurement {
    const digest = readRelationJson(pointer);
    if (typeof digest !== "string") throw new Error("invalid relation cache pointer");
    const cached = readArtifact(root, digest) as RelationMeasurement;
    if (cached.fingerprint !== m.fingerprint || cached.evidenceHash !== packet.evidenceHash || cached.contractHash !== m.contractHash || !cached.raw || cached.engineIdentity !== job.engine.identity) throw new Error("relation cache mismatch");
    parseAnswer(cached.raw, contract);
    const interpretation = interpretAnswer(contract, cached.raw, job.engine.band);
    return { ...m, raw: cached.raw, choice: typeof interpretation.value === "string" ? interpretation.value : null, status: interpretation.status, reason: interpretation.reason ?? null, servedModel: cached.servedModel, response: cached.response, probabilitySource: cached.probabilitySource, cached: true };
}
