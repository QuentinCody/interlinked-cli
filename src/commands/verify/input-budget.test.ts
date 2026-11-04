import { expect, it } from "vitest";
import { verifyInputExclusion, VERIFY_INLINE_MAX_BYTES } from "./input-budget.js";

it("MUST-EXCLUDE generated, codegen-data and oversized inputs", () => {
    expect(verifyInputExclusion("// @generated\nexport const x=1")).toBe("generated");
    expect(verifyInputExclusion("// @codegen-data: frozen fixture\nexport const x=1")).toBe("codegen-data");
    expect(verifyInputExclusion("é".repeat(VERIFY_INLINE_MAX_BYTES))).toBe("oversized");
});
it("MUST-NOT-EXCLUDE ordinary code, marker strings and a deep example", () => {
    expect(verifyInputExclusion('const marker = "@codegen-data";')).toBeNull();
    expect(verifyInputExclusion("\n".repeat(21) + "// @codegen-data")).toBeNull();
    expect(verifyInputExclusion("export const x = 1;")).toBeNull();
});
