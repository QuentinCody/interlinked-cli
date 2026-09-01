// ===========================================
// TSC Overlay Sidecar — wire protocol
// ===========================================
// Minimal line-delimited JSON protocol shared by the daemon-side client
// (tsc-overlay-sidecar-client.ts) and the sidecar process entry
// (tsc-overlay-sidecar-main.ts). Kept dumb and versioned per the sidecar
// spec: one request in, one response out, no framing beyond a trailing
// newline.

import type { CheckResult } from "../types.js";
import type { RunTscOverlayInput } from "./tsc-overlay-service.js";

/** Bump when the request/response SHAPE changes in a way old sidecars can't
 *  answer correctly. The client does not currently reject mismatched
 *  versions (there is only one version in the field); the field exists so a
 *  future breaking change has somewhere to land a check. */
export const SIDECAR_PROTOCOL_VERSION = 1;

export interface SidecarOverlayRequest {
	id: number;
	method: "overlayCheck";
	protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
	params: RunTscOverlayInput;
}

interface SidecarOverlayResponseOk {
	id: number;
	result: CheckResult[];
}

interface SidecarOverlayResponseErr {
	id: number;
	error: string;
}

export type SidecarOverlayResponse = SidecarOverlayResponseOk | SidecarOverlayResponseErr;

/** Type guard for a parsed response's error branch. */
export function isSidecarErrorResponse(
	r: SidecarOverlayResponse,
): r is SidecarOverlayResponseErr {
	// SAFETY: SidecarOverlayResponse is a two-branch union (ok | err); reading
	// `.error` on the union narrows via the `in` check below, no cast needed
	// beyond this — the runtime check itself IS the discriminant.
	return "error" in r && typeof r.error === "string";
}
