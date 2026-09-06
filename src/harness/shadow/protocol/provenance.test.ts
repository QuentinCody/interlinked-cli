import { describe, expect, it } from "vitest";
import { BINDING_PROVENANCE, contractsFor, flattenContract, provenanceLeaves } from "./provenance.js";
import type { FieldContract, LeafContract } from "./types-binding.js";

const contracts: Array<[string, FieldContract]> = Object.entries(BINDING_PROVENANCE).flatMap(([leaf, contract]) =>
	flattenContract(contract).map((flat): [string, FieldContract] => [leaf, flat]),
);

describe("BINDING_PROVENANCE — independent verification (must hold)", () => {
	it("P1: every content field is measured by a party other than the one that asserted or expected it", () => {
		for (const [field, contract] of contracts) {
			if (contract.authority !== "content") continue;
			const claimant = contract.asserted_by ?? contract.expected_by;
			expect(claimant, field).toBeDefined();
			expect(contract.measured_by, field).not.toBe(claimant);
		}
	});

	it("P2: every freshness field is daemon-asserted and daemon-measured, never broker-expected", () => {
		for (const [field, contract] of contracts) {
			if (contract.authority !== "freshness") continue;
			expect(contract.asserted_by, field).toBe("daemon");
			expect(contract.measured_by, field).toBe("daemon");
			expect(contract.expected_by, field).toBeUndefined();
		}
	});

	it("P3: every policy field is expected by broker policy and measured by the materializer", () => {
		for (const [field, contract] of contracts) {
			if (contract.authority !== "policy") continue;
			expect(contract.expected_by, field).toBe("broker_policy");
			expect(contract.measured_by, field).toBe("materializer");
		}
	});

	it("P4: every identity leaf is expected by broker authority and never measured by the daemon", () => {
		for (const [field, contract] of contracts) {
			if (contract.authority !== "identity") continue;
			expect(contract.expected_by, field).toBe("broker_authority");
			expect(contract.measured_by, field).not.toBe("daemon");
		}
	});

	it("P4b: the mirror KEY is server-issued; version and base_ref are daemon claims checked against authority", () => {
		for (const leaf of ["mirror.key.repository_id", "mirror.key.session_id", "mirror.key.kind"] as const) {
			expect(BINDING_PROVENANCE[leaf].asserted_by, leaf).toBeUndefined();
		}
		for (const leaf of ["mirror.version", "base_ref"] as const) {
			expect(BINDING_PROVENANCE[leaf].asserted_by, leaf).toBe("daemon");
		}
	});

	it("P5a: mirror version and base ref are broker-authority identity, measured remotely", () => {
		for (const leaf of ["mirror.version", "base_ref"] as const) {
			const contract = BINDING_PROVENANCE[leaf];
			expect(contract.authority).toBe("identity");
			expect(contract.expected_by).toBe("broker_authority");
			expect(contract.measured_by).toBe("materializer");
		}
	});

	it("P5b: dependency source is conditional — fresh is a materializer fact, cache is corroborated", () => {
		const [fresh, cache] = flattenContract(BINDING_PROVENANCE["dependencies.source"]);
		expect(fresh?.authority).toBe("execution_fact");
		expect(fresh?.expected_by).toBeUndefined();
		expect(cache?.expected_by).toBe("broker_cache");
	});

	it("P5c: the dependency TREE hash has separate fresh (fact) and cache (corroborated) contracts", () => {
		const tree: LeafContract = BINDING_PROVENANCE["dependencies.tree_hash"];
		const [fresh, cache] = flattenContract(tree);
		expect(flattenContract(tree)).toHaveLength(2);
		expect(fresh?.authority).toBe("execution_fact");
		expect(cache?.authority).toBe("content");
		expect(cache?.expected_by).toBe("broker_cache");
	});

	it("P6: contractsFor resolves a conditional leaf by dependency source", () => {
		expect(contractsFor("dependencies.tree_hash", "fresh").authority).toBe("execution_fact");
		expect(contractsFor("dependencies.tree_hash", "cache").authority).toBe("content");
		expect(contractsFor("pre_tree_hash", "fresh").authority).toBe("content");
	});
});

describe("BINDING_PROVENANCE — census (must not regress)", () => {
	it("N1: the table's keys are exactly the generated leaf census — no leaf without a contract", () => {
		expect(Object.keys(BINDING_PROVENANCE).sort()).toEqual([...provenanceLeaves()].sort());
	});

	it("N2: no contract is measured by nobody, and every dependency leaf is present", () => {
		for (const [field, contract] of contracts) {
			expect(contract.measured_by, field).toBeTruthy();
		}
		for (const leaf of ["dependencies.mode", "dependencies.input_hash", "dependencies.cache_record_hash"]) {
			expect(Object.keys(BINDING_PROVENANCE)).toContain(leaf);
		}
	});
});
