import { describe, expect, it } from "vitest";
import { parseShadowOutcome } from "./parse-outcome.js";
import { parseDeletionReceipt } from "./parse-records.js";
import { parseManifestUploadInitRequest, parseMirrorFinalizeStatusResponse } from "./parse-transport.js";

const cases = ["constructor", "toString", "__proto__"].flatMap(tag => [
	{ name: "completed outcome", tag, parse: parseShadowOutcome, raw: { schema_version: 1, status: "completed", kind: tag }, field: "outcome.kind" },
	{ name: "upload scope", tag, parse: parseManifestUploadInitRequest, raw: { schema_version: 1, scope: { kind: tag } }, field: "manifest_upload_init_request.scope.kind" },
	{ name: "finalize status", tag, parse: parseMirrorFinalizeStatusResponse, raw: { schema_version: 1, attempt_id: "attempt", state: tag }, field: "mirror_finalize_status.state" },
	{ name: "deletion receipt", tag, parse: parseDeletionReceipt, raw: { state: tag }, field: "deletion_receipt.state" },
]);

describe("unknown shadow protocol discriminator values", () => {
	it.each(cases)("rejects Object.prototype name $tag in $name without throwing", ({ parse, raw, field }) => {
		expect(parse(raw)).toEqual({ ok: false, reason: expect.stringContaining(field) });
	});
});
