import { isGeneratedFile } from "../../harness/checks/shared.js";

export const VERIFY_INLINE_MAX_BYTES = 256 * 1024;
/** Whole-file AST/advisory scans never consume generated or oversized inputs. */
export function verifyInputExclusion(content: string): "generated" | "codegen-data" | "oversized" | null {
    if (Buffer.byteLength(content) > VERIFY_INLINE_MAX_BYTES) return "oversized";
    const head = content.split("\n", 20).join("\n");
    if (/^\s*(?:\/\/|\/\*|\*|#|<!--)\s*@codegen-data\b/m.test(head)) return "codegen-data";
    return isGeneratedFile(content) ? "generated" : null;
}
