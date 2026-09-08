/** Read Ruff's inheritance field without interpreting unrelated TOML values. */
const TOML_TOKENS = /"""(?:\\[\s\S]|(?!""")[^\\])*"""|'''[\s\S]*?'''|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*/g;

function literal(raw: string): string {
    const width = raw.startsWith('"""') || raw.startsWith("'''") ? 3 : 1;
    let body = raw.slice(width, -width);
    if (width === 3) body = body.replace(/^\r?\n/, "");
    if (raw.startsWith("'")) return body;
    // Unsupported TOML escapes fail visibly rather than guessing a path.
    const parsed: unknown = JSON.parse(`"${body.replace(/\r?\n/g, "\\n")}"`);
    if (typeof parsed !== "string") throw new Error("Expected a literal TOML string");
    return parsed;
}

function keyParts(key: string, strings: Map<string, string>): string[] {
    return key.split(".").map((part) => {
        const name = part.trim();
        const quoted = strings.get(name);
        return quoted === undefined ? name : literal(quoted);
    });
}

function inlineAssignments(value: string): string[] {
    const assignments: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (char === "{" || char === "[") depth++;
        if (char === "}" || char === "]") depth--;
        if (char === "," && depth === 0) {
            assignments.push(value.slice(start, index));
            start = index + 1;
        }
    }
    assignments.push(value.slice(start));
    return assignments;
}

interface Selection { target: string[]; strings: Map<string, string> }

function selectAssignment(assignment: string, prefix: string[], selection: Selection): string[] {
    const { target, strings } = selection;
    const equals = assignment.indexOf("=");
    if (equals < 0) return [];
    const path = [...prefix, ...keyParts(assignment.slice(0, equals), strings)];
    if (!path.every((part, index) => part === target[index])) return [];
    const value = assignment.slice(equals + 1).trim();
    if (path.length === target.length) {
        const raw = strings.get(value);
        if (raw === undefined) throw new Error("Ruff extend requires a literal string for inheritance review");
        return [literal(raw)];
    }
    if (!value.startsWith("{")) return [];
    if (!value.endsWith("}")) throw new Error("Multiline inline TOML inheritance requires review");
    return inlineAssignments(value.slice(1, -1)).flatMap((part) => selectAssignment(part, path, selection));
}

export function ruffInheritance(content: string, pyproject: boolean): string[] {
    const strings = new Map<string, string>();
    const masked = content.replace(TOML_TOKENS, (token) => {
        if (token.startsWith("#")) return "";
        const key = `\0${strings.size}\0`;
        strings.set(key, token);
        return key;
    });
    const target = pyproject ? ["tool", "ruff", "extend"] : ["extend"];
    let table: string[] = [];
    const paths: string[] = [];
    for (const line of masked.split(/\r?\n/)) {
        const header = line.match(/^\s*(?:\[([^\[\]]+)\]|\[\[([^\[\]]+)\]\])\s*$/);
        const tableName = header?.[1] ?? header?.[2];
        if (tableName !== undefined) table = keyParts(tableName, strings);
        else paths.push(...selectAssignment(line, table, { target, strings }));
    }
    return paths;
}
