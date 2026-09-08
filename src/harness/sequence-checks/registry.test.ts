import { describe, expect, it } from "vitest";

import { signatureChangeCallersNotUpdated } from "./quality.js";
import { ALL_SEQUENCE_DETECTORS, getSequenceDetectorById } from "./registry.js";

describe("ALL_SEQUENCE_DETECTORS", () => {
	it("includes the signature-change detector", () => {
		expect(ALL_SEQUENCE_DETECTORS).toContain(signatureChangeCallersNotUpdated);
	});

	it("contains no duplicate ids", () => {
		const ids = ALL_SEQUENCE_DETECTORS.map((d) => d.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("requires every entry to be fully_deterministic", () => {
		for (const detector of ALL_SEQUENCE_DETECTORS) {
			expect(detector.determinism).toBe("fully_deterministic");
		}
	});
});

describe("getSequenceDetectorById", () => {
	it("returns the detector for a known id", () => {
		expect(getSequenceDetectorById(signatureChangeCallersNotUpdated.id)).toBe(signatureChangeCallersNotUpdated);
	});

	it("returns undefined for an unknown id", () => {
		expect(getSequenceDetectorById("nonexistent_detector_id_xyz")).toBeUndefined();
	});
});
