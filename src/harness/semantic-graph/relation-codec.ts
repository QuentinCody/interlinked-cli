import { parseBand, loopbackUrl } from "../../lib/decision-metrics/config.js";
import { interpretAnswer, parseAnswer } from "../../lib/decision-metrics/answers.js";
import { RELATION_CONTRACTS, validatePacketPopulation } from "../../lib/decision-metrics/relation-contracts.js";
import { hash, integer, parsePolicy, record, strings, text, textHash, unique } from "./relation-core.js";
import type { EngineSpec, RelationMeasurement, RelationJob, RelationPacket, RelationPlan, RelationRun, RelationSnapshot } from "./relation-types.js";
import { makeRelationPacket } from "./relation-packet.js";
import { relationRequest } from "../../lib/decision-metrics/relation-engines.js";

export function parseEngine(value: unknown): EngineSpec {
    const r = record(value);
    if (!["ollama", "typesafe", "haiku"].includes(String(r.backend))) throw new Error("unknown relation backend");
    if (r.command !== null) text(r.command);
    if (r.endpoint !== null) loopbackUrl(text(r.endpoint), r.backend === "typesafe");
    if (r.backend === "haiku" && (r.effort !== "low" || !r.command)) throw new Error("H requires a command and low effort");
    if (r.backend === "ollama" && (!r.command || !r.endpoint)) throw new Error("D requires ThinkThen and a loopback endpoint");
    if (typeof r.maxUsd !== "number" || !Number.isFinite(r.maxUsd) || r.maxUsd <= 0 || r.maxUsd > 100) throw new Error("invalid spend cap");
    return { id: text(r.id), backend: r.backend as EngineSpec["backend"], model: text(r.model), identity: text(r.identity), command: r.command as string | null, endpoint: r.endpoint as string | null, effort: r.effort === "low" ? "low" : null, maxCalls: integer(r.maxCalls, 1, 10000), maxUsd: r.maxUsd, timeoutMs: integer(r.timeoutMs, 100, 300000), band: parseBand(r.band) };
}
export function validateSnapshot(snapshot: RelationSnapshot): void {
    const { digest, ...body } = snapshot;
    if (snapshot.schema !== "interlinked.relation-snapshot/1" || hash(body) !== digest) throw new Error("snapshot digest mismatch");
    for (const file of Object.values(snapshot.files)) if (textHash(file.text) !== file.hash) throw new Error("source hash mismatch");
    unique(snapshot.units.map(u => u.id), "unit id");
    for (const unit of snapshot.units) {
        const source = snapshot.files[unit.file];
        if (!source || source.text.split(/\r?\n/).slice(unit.line - 1, unit.endLine).join("\n") !== unit.text || textHash(unit.text) !== unit.hash) throw new Error("unit source mismatch");
    }
}
export function validatePacket(packet: RelationPacket, snapshot: RelationSnapshot): void {
    if (packet.schema !== "interlinked.relation-packet/1") throw new Error("unsupported packet schema");
    if (packet.evidenceHash !== hash({ evidence: packet.evidence, dependencies: packet.dependencies, missing: packet.missing }) || packet.id !== hash({ logicalKey: packet.logicalKey, evidenceHash: packet.evidenceHash })) throw new Error("packet digest mismatch");
    if (packet.complete !== (packet.missing.length === 0)) throw new Error("packet completeness mismatch");
    unique(packet.participants, "packet participant");
    for (const participant of packet.participants) if (!snapshot.units.some(u => u.id === participant && packet.dependencies[`unit:${u.id}`] === u.hash)) throw new Error("packet participant outside snapshot");
    validatePacketPopulation(packet);
}
export function parseRelationPlan(value: unknown): RelationPlan {
    const r = record(value);
    if (r.schema !== "interlinked.relation-plan/1" || !Array.isArray(r.jobs) || !Array.isArray(r.coverage)) throw new Error("unsupported relation plan");
    if (r.kind !== "single_snapshot" && r.kind !== "paired_snapshots") throw new Error("unsupported plan kind");
    const { id, ...body } = r;
    if (id !== hash(body)) throw new Error("plan digest mismatch");
    if (r.contractDigest !== hash(RELATION_CONTRACTS)) throw new Error("contract changed; reprepare with the current contracts");
    const policy = record(r.policy);
    if (hash(parsePolicy(policy.policy)) !== policy.digest) throw new Error("policy digest mismatch");
    strings(r.unmatched); strings(r.sourcePlans); text(r.createdAt);
    // All nested identities, populations, and source closure are checked before use.
    const plan = value as RelationPlan;
    validateRelationJobs(plan);
    if (!plan.jobs.length) throw new Error("plan has no jobs");
    return plan;
}
function validateRelationJobs(plan: RelationPlan) {
    unique(plan.jobs.map(j => j.id), "job id");
    for (const job of plan.jobs) {
        parseEngine(job.engine); validateSnapshot(job.snapshot);
        if (!Array.isArray(job.packets)) throw new Error("invalid packet array");
        unique(job.packets.map(p => p.id), "packet id");
        for (const packet of job.packets) {
            validatePacket(packet, job.snapshot);
            const invariant = plan.policy.policy.invariants.find(i => i.id === packet.invariantId);
            const scenario = plan.policy.policy.scenarios.find(s => s.id === packet.scenarioId) ?? null;
            if (!invariant || (packet.scenarioId !== null && !scenario)) throw new Error("packet policy reference missing");
            const rebuilt = makeRelationPacket(packet.kind, invariant, packet.participants.map(id => job.snapshot.units.find(u => u.id === id)!), job.snapshot, scenario, packet.queriedRole, 24000, packet.expectedParticipants);
            if (hash(rebuilt.evidence) !== hash(packet.evidence) || hash(rebuilt.dependencies) !== hash(packet.dependencies) || rebuilt.logicalKey !== packet.logicalKey) throw new Error("packet evidence differs from pinned source/policy");
            if (rebuilt.missing.some(reason => !packet.missing.includes(reason))) throw new Error("packet omits missing evidence");
        }
        if (!(plan.kind === "paired_snapshots" ? ["before", "after"] : ["single"]).includes(job.side)) throw new Error("invalid job side");
    }
}

export function parseRelationRun(value: unknown): RelationRun {
    const r = record(value);
    if (r.schema !== "interlinked.relation-run/2" || !Array.isArray(r.measurements)) throw new Error("unsupported relation run");
    const { id, ...body } = r;
    if (id !== hash(body)) throw new Error("run digest mismatch");
    const plan = parseRelationPlan(r.plan);
    const run = value as RelationRun;
    unique(run.measurements.map(m => `${m.jobId}:${m.packetId}`), "measurement");
    for (const m of run.measurements) {
        const job = plan.jobs.find(j => j.id === m.jobId), packet = job?.packets.find(p => p.id === m.packetId);
        if (!job || !packet || m.schemaVersion !== 2 || m.armId !== job.engine.id || m.recordKind !== packet.kind || m.populationId !== packet.populationId || m.unit !== packet.unit || m.logicalKey !== packet.logicalKey || m.evidenceHash !== packet.evidenceHash) throw new Error("measurement population mismatch");
        if (!["answered", "insufficient_evidence", "abstained", "failed", "unassessed"].includes(m.status)) throw new Error("invalid assessment status");
        validateMeasurementEvidence(m, job, packet);
        if (m.status === "answered" && (!m.raw || !m.choice || !RELATION_CONTRACTS[m.recordKind].options?.[m.choice])) throw new Error("answered measurement requires a valid answer");
    }
    if (run.complete !== (run.measurements.length === plan.jobs.reduce((n, j) => n + j.packets.length, 0))) throw new Error("run completeness mismatch");
    return run;
}

function validateMeasurementEvidence(m: RelationMeasurement, job: RelationJob, packet: RelationPacket) {
    const contract = RELATION_CONTRACTS[m.recordKind];
    if (m.snapshotDigest !== undefined && m.snapshotDigest !== job.snapshot.digest) throw new Error("measurement snapshot mismatch");
    if (m.contractHash !== hash(contract) || m.engineIdentity !== job.engine.identity || m.requestedModel !== job.engine.model || m.fingerprint !== hash({ packet: packet.evidenceHash, request: relationRequest(packet), contractHash: hash(contract), engine: job.engine, ...(m.snapshotDigest ? { snapshot: m.snapshotDigest } : {}) })) throw new Error("measurement configuration/fingerprint mismatch");
    for (const amount of [m.calls, m.durationMs, m.costUsd, m.inputTokens]) if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) throw new Error("invalid measurement accounting");
    integer(m.calls, 0, 10000);
    if (typeof m.cached !== "boolean" || !["backend_distribution", "self_report", "unavailable"].includes(m.probabilitySource)) throw new Error("invalid measurement provenance");
    if (m.raw) parseAnswer(m.raw, RELATION_CONTRACTS[m.recordKind]);
    if (!["failed", "unassessed"].includes(m.status)) {
        if (!m.raw) throw new Error("assessed measurement requires raw answer");
        const interpreted = interpretAnswer(contract, m.raw, job.engine.band);
        if (m.status !== interpreted.status || m.choice !== (typeof interpreted.value === "string" ? interpreted.value : null)) throw new Error("interpretation differs from retained probabilities/band");
        if (job.engine.backend !== "ollama" && m.servedModel !== job.engine.model) throw new Error("served model differs from pinned release");
    }
}
