import { describe, expect, it } from "vitest";
import {
	findSimplificationCapabilities,
	parseSimplificationCapabilityCatalog,
	simplificationCapabilityCatalogSha256,
	type SimplificationCapabilityCatalog,
} from "./simplification-capability-catalog.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function fixture() {
	return {
		schema_version: "simplification-capability-catalog/v1",
		catalog_id: "node-22-contracts",
		entries: [{
			id: "node22:path.matchesGlob",
			remedy: "stdlib",
			capability: "path.matchesGlob",
			target: { name: "node", version: "22.14.0" },
			support: "available",
			equivalence: "fixture-validated",
			contract_sha256: SHA_A,
			fixture_sha256: SHA_B,
			provenance: {
				source: "pinned Node API documentation and compatibility fixture",
				source_sha256: SHA_C,
				checked_at: "2026-08-30T12:00:00.000Z",
			},
			limitations: ["glob dialect must match the repository contract"],
		}],
	};
}

function parsedFixture(): Readonly<SimplificationCapabilityCatalog> {
	const parsed = parseSimplificationCapabilityCatalog(fixture());
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.catalog;
}

describe("simplification capability catalog", () => {
	it("parses, content-addresses, and selects an exact pinned runtime entry", () => {
		const catalog = parsedFixture();
		expect(simplificationCapabilityCatalogSha256(catalog)).toMatch(/^[a-f0-9]{64}$/);
		expect(findSimplificationCapabilities(
			catalog,
			{ name: "node", version: "22.14.0" },
			"stdlib",
		)).toHaveLength(1);
		expect(findSimplificationCapabilities(
			catalog,
			{ name: "node", version: "22.15.0" },
		)).toEqual([]);
	});

	it("rejects unpinned versions and fixture claims without fixture evidence", () => {
		const unpinned = fixture();
		unpinned.entries[0]!.target = { name: "node", version: "latest" };
		expect(parseSimplificationCapabilityCatalog(unpinned).ok).toBe(false);
		const ranged = fixture();
		ranged.entries[0]!.target = { name: "node", version: "^22.14.0" };
		expect(parseSimplificationCapabilityCatalog(ranged).ok).toBe(false);

		const missingFixture = { ...fixture(), entries: [{ ...fixture().entries[0]!, fixture_sha256: null }] };
		expect(parseSimplificationCapabilityCatalog(missingFixture).ok).toBe(false);
	});

	it("rejects duplicate or non-canonical entry ids", () => {
		const invalid = fixture();
		invalid.entries.unshift({ ...invalid.entries[0]!, id: "z-last" });
		expect(parseSimplificationCapabilityCatalog(invalid).ok).toBe(false);
	});

	it("rejects a provenance object carrying an unexpected key", () => {
		const base = fixture();
		const entry = base.entries[0]!;
		const withExtraKey = { ...base, entries: [{ ...entry, provenance: { ...entry.provenance, extra_field: "unexpected" } }] };
		const result = parseSimplificationCapabilityCatalog(withExtraKey);
		expect(result).toEqual({ ok: false, reason: "capability catalog contains an invalid entry" });
	});

	it("rejects a provenance whose checked_at is not a canonical ISO timestamp", () => {
		const badTimestamp = fixture();
		const provenance = badTimestamp.entries[0]!.provenance;
		badTimestamp.entries[0]!.provenance = { ...provenance, checked_at: "2026-08-30" };
		const result = parseSimplificationCapabilityCatalog(badTimestamp);
		expect(result).toEqual({ ok: false, reason: "capability catalog contains an invalid entry" });
	});

	it("rejects an entry with an empty capability field", () => {
		const emptyCapability = fixture();
		emptyCapability.entries[0]!.capability = "";
		const result = parseSimplificationCapabilityCatalog(emptyCapability);
		expect(result).toEqual({ ok: false, reason: "capability catalog contains an invalid entry" });
	});

	it("rejects an entry with a support value outside the closed set", () => {
		const badSupport = fixture();
		badSupport.entries[0]!.support = "sometimes";
		// equivalence must stay off "fixture-validated" so the ONLY rejection path
		// is the support member check, not the downstream support/equivalence
		// consistency check (both share the same generic reason string).
		badSupport.entries[0]!.equivalence = "contract-checked";
		const result = parseSimplificationCapabilityCatalog(badSupport);
		expect(result).toEqual({ ok: false, reason: "capability catalog contains an invalid entry" });
	});

	it("rejects an entry object carrying an unexpected key", () => {
		const extraKey = { ...fixture(), entries: [{ ...fixture().entries[0]!, extra_field: "unexpected" }] };
		const result = parseSimplificationCapabilityCatalog(extraKey);
		expect(result).toEqual({ ok: false, reason: "capability catalog contains an invalid entry" });
	});

	it("rejects catalog input that is not a plain JSON object", () => {
		const result = parseSimplificationCapabilityCatalog("not-a-catalog");
		expect(result).toEqual({
			ok: false,
			reason: "capability catalog has an unknown or missing field",
		});
	});

	it("rejects a catalog whose entries field is not an array", () => {
		const raw = { ...fixture(), entries: "not-an-array" };
		const result = parseSimplificationCapabilityCatalog(raw);
		expect(result).toEqual({
			ok: false,
			reason: "capability catalog version, id, or entries are invalid",
		});
	});
});
