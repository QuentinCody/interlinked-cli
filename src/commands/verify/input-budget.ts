import { isGeneratedFile } from "../../harness/checks/shared.js";

/** Whole-file scans retain arbitrary source sizes and explicit generated scope. */
export function verifyInputExclusion(content: string): "generated" | "codegen-data" | null {
    const head = content.split("\n", 20).join("\n");
    if (/^\s*(?:\/\/|\/\*|\*|#|<!--)\s*@codegen-data\b/m.test(head)) return "codegen-data";
    return isGeneratedFile(content) ? "generated" : null;
}
