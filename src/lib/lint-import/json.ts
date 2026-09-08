/** Invalid state is an unavailable measurement, never an empty successful report. */
export function lintJson(content: string): unknown {
    try { return JSON.parse(content); }
    catch (error) { throw new Error("Invalid lint JSON; no verdict", { cause: error }); }
}

export function lintObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
    // SAFETY: arrays/null/primitives are excluded; each field remains unknown.
    return value as Record<string, unknown>;
}

/** JSONC lexical stripping protects quoted strings; JSON.parse still validates the resulting grammar. */
export function lintJsonc(content: string): unknown {
    const withoutComments = content.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (token) => token.startsWith('"') ? token : token.replace(/[^\r\n]/g, " "));
    const withoutTrailingCommas = withoutComments.replace(/"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/g, (token) => token.startsWith(",") ? token.slice(1) : token);
    return lintJson(withoutTrailingCommas);
}
