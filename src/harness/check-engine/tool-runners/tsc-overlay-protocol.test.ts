import { describe, expect, it } from "vitest";
import {
	isSidecarErrorResponse,
	SIDECAR_PROTOCOL_VERSION,
	type SidecarOverlayResponse,
} from "./tsc-overlay-protocol.js";

describe("tsc-overlay-protocol", () => {
	// kind: public-api — positive (must fire)
	it("P1: isSidecarErrorResponse recognizes an error-shaped response", () => {
		const res: SidecarOverlayResponse = { id: 1, error: "boom" };
		expect(isSidecarErrorResponse(res)).toBe(true);
	});

	// kind: public-api — negative (must not fire)
	it("N1: isSidecarErrorResponse rejects an ok-shaped response", () => {
		const res: SidecarOverlayResponse = { id: 1, result: [] };
		expect(isSidecarErrorResponse(res)).toBe(false);
	});

	// kind: public-api — negative (must not fire)
	it("N3: an ok-shaped reply that carries notMeasured is not an error response (review r6, finding 2)", () => {
		const res: SidecarOverlayResponse = { id: 1, result: [], notMeasured: "project_orphan: no project claims the file" };
		expect(isSidecarErrorResponse(res)).toBe(false);
	});

	it("N2: protocol version is a stable positive integer", () => {
		expect(Number.isInteger(SIDECAR_PROTOCOL_VERSION)).toBe(true);
		expect(SIDECAR_PROTOCOL_VERSION).toBeGreaterThan(0);
	});
});
