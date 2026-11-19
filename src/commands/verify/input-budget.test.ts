import { expect, it } from "vitest";
import { verifyInputExclusion } from "./input-budget.js";

it("MUST-EXCLUDE explicitly generated and codegen-data inputs", () => {
    expect(verifyInputExclusion("// @generated\nexport const x=1")).toBe("generated");
    expect(verifyInputExclusion("// @codegen-data: frozen fixture\nexport const x=1")).toBe("codegen-data");
    expect(verifyInputExclusion("é".repeat(1024 * 1024))).toBeNull();
});
it("MUST-NOT-EXCLUDE ordinary code, marker strings and a deep example", () => {
    expect(verifyInputExclusion('const marker = "@codegen-data";')).toBeNull();
    expect(verifyInputExclusion("\n".repeat(21) + "// @codegen-data")).toBeNull();
    expect(verifyInputExclusion("export const x = 1;")).toBeNull();
});
