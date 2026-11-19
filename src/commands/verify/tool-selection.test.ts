import { expect, it } from "vitest";
import { resolveVerifyToolIds } from "./tool-selection.js";

it("resolves focused tools from the complete catalog, including languages absent from the legacy skip table", () => {
	expect(resolveVerifyToolIds(["tsc"])).toEqual(["tsc"]);
	expect(resolveVerifyToolIds(["rustfmt"])).toEqual(["rustfmt"]);
	expect(resolveVerifyToolIds(["typescript", "cargo_clippy"])).toEqual(["tsc", "cargo-clippy"]);
});

it("retains empty unmatched selection and deduplicates canonical aliases", () => {
	expect(resolveVerifyToolIds(["nonexistent", "sca", ""])).toEqual([]);
	expect(resolveVerifyToolIds(["tsc", "typescript", "tsc"])).toEqual(["tsc"]);
});
