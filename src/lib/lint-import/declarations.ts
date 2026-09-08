export interface LintRuleDeclaration {
    id: string;
    value: string;
    line: number;
    interpretation: "declaration" | "selector";
}

/** Static rule/selector candidates for review. Never used to manufacture replacement algorithms. */
export function lintRuleDeclarations(content: string): LintRuleDeclaration[] {
    const rules: LintRuleDeclaration[] = [];
    const lines = content.split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
        const setting = text.match(/^\s*["']?([@\w][\w/@.:-]*)["']?\s*[:=]\s*(.*)/);
        const value = setting?.[2] ?? "";
        if (setting && /^(?:\[\s*)?(?:"(?:error|warn|warning|off|deny|allow|forbid)"|'(?:error|warn|warning|off|deny|allow|forbid)'|(?:error|warn|warning|off|deny|allow|forbid)|[012])(?=\s|[,}\]]|$)/.test(value)) {
            rules.push({ id: setting[1] ?? "", value, line: index + 1, interpretation: "declaration" });
        }
        const selector = text.match(/^\s*(?:extend-)?(?:select|ignore|enable|disable|Checks)\s*[:=]\s*(.*)/);
        if (selector) rules.push({ id: text.trim().split(/[:=]/)[0]?.trim() ?? "", value: selector[1] ?? "", line: index + 1, interpretation: "selector" });
    }
    return rules;
}
