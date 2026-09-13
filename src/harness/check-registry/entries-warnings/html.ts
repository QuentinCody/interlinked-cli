import { checkHtmlDuplicateId } from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const HTML_ENTRIES: CheckRegistration[] = [
    {
        id: "html_duplicate_id",
        name: "Duplicate HTML ID",
        description: "Detects repeated static, case-sensitive id attribute values in an explicit <body> in .html/.htm files. Excludes comments, script/raw-text contents, inert template contents, and dynamic ID expressions. Compares entity spellings literally; does not evaluate template control flow or runtime DOM changes.",
        tier: 1,
        determinism: "heuristic",
        severity: "warning",
        pipeline: "agent_safety",
        phase: "post",
        fix_instruction: "Give each element a unique id and update its matching links, labels, ARIA references, and selectors. Use a class when multiple elements need the same styling or behavior.",
        fn: checkHtmlDuplicateId,
        resultsPropName: "htmlDuplicateId",
        content_keywords: ["id"],
    },
];
