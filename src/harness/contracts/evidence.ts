import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { contractDigest, contractPath, readContractFile, CONTRACT_MANIFEST, CONTRACT_POLICY } from "./paths.js";
import { parseContractManifest, parseContractPolicy } from "./schema.js";
import type { ContractCase, ContractEvidence, ContractManifest, ContractPolicy, ContractReport } from "./types.js";

function expectationMatchesSource(row: ContractCase): boolean {
    if (!row.source.observation) return true;
    if (row.source.observation === "stdout") return row.expect.stdout === row.source.quote;
    const example: unknown = JSON.parse(row.source.quote);
    if (row.source.observation === "json") return Object.hasOwn(row.expect, "json") && isDeepStrictEqual(row.expect.json, example);
    if (!example || typeof example !== "object" || !("expect" in example)) return false;
    return isDeepStrictEqual(row.expect, example.expect);
}

export function inspectCase(root: string, row: ContractCase, policy: ContractPolicy): ContractEvidence {
    const digest = contractDigest(row);
    const evidence: ContractEvidence = { contract: row, id: row.id, digest, authority: Object.hasOwn(policy.accepted, digest) ? "configured" : "proposed", provenance: "unavailable", state: "not-run", details: [], durationMs: 0 };
    try {
        const content = readContractFile(root, row.source.path);
        if (contractDigest(content) !== row.source.sha256 || !content.includes(row.source.quote)) {
            evidence.provenance = "stale";
            evidence.details.push("Requirement bytes or quoted evidence changed; review expectations before execution.");
        } else if (!expectationMatchesSource(row)) {
            evidence.provenance = "conflict";
            evidence.details.push("Declared expectation contradicts the exact observation in its cited example; review before running.");
        } else {
            evidence.provenance = row.source.kind === "inferred" ? "inferred" : "matched";
            evidence.details.push("Citation matches bytes; semantic agreement still requires review.");
        }
    } catch (error) { evidence.details.push(String(error)); }
    return evidence;
}

export function inspectContracts(root: string, path = CONTRACT_MANIFEST): { manifest: ContractManifest; policy: ContractPolicy; report: ContractReport } {
    const manifest = parseContractManifest(readContractFile(root, path));
    const policy = existsSync(contractPath(root, CONTRACT_POLICY)) ? parseContractPolicy(readContractFile(root, CONTRACT_POLICY)) : { version: 1 as const, accepted: {} };
    const cases = manifest.cases.map(row => inspectCase(root, row, policy));
    const represented = new Set(cases.map(row => row.digest));
    const gaps = Object.keys(policy.accepted).filter(digest => !represented.has(digest)).map(digest => `Accepted case ${digest} is absent or changed; a new passing expectation cannot establish preservation.`);
    if (!cases.length) gaps.push("No executable contract cases declared.");
    return { manifest, policy, report: { version: 1, cases, gaps, elapsedMs: 0, reuse: "none-external-state-unsealed" } };
}

/** Explicit JSON fences are data, never shell instructions; import does not execute. */
export function importContractExamples(root: string, path: string): ContractManifest {
    const content = readContractFile(root, path), cases: unknown[] = [];
    const blocks = content.matchAll(/^```json interlinked-contract\s*\n([\s\S]*?)^```\s*$/gm);
    for (const block of blocks) {
        const quote = block[1]!.trim(), value: unknown = JSON.parse(quote);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Contract example must be an object");
        cases.push({ ...value, source: { kind: "example", path, sha256: contractDigest(content), quote, observation: "contract-example" } });
    }
    return parseContractManifest(JSON.stringify({ version: 1, cases }));
}
