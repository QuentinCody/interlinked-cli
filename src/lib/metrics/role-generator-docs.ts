import { posix } from "node:path";
import { resolveClaims, type ResolvedClaim } from "./role-generator-claims.js";

/**
 * A statement in a repository document that names a generator and a tracked path on one line, such as "The client in `src/api` is generated
 * by openapi-python-client". It is the weakest kind: prose can be stale and anyone can write it. It never sets a file aside alone; it
 * confirms a directory that the structure measure found uniform. A generator named without a path, a path without a generator, a URL and a
 * path that names nothing tracked are not statements.
 */
const GENERATOR = /\b(openapi-python-client|openapi-generator(?:-cli)?|openapi-typescript|openapi-ts|hey-api|orval|swagger-typescript-api|protoc|grpc_tools|sqlc|prisma|graphql-codegen|graphql-code-generator|oapi-codegen|datamodel-codegen|quicktype|stainless|speakeasy|fern|typeshare|flatc|thrift|antlr4?|mockgen|kubb|ogen)\b/i;
const GENERATING = /\bgenerat(?:e|es|ed|ing|or|ion)\b/i;
const TOKEN = /`([^`\s]+)`|(?<![\w/.:-])((?:\.\.?\/)?(?:[\w.@-]+\/)+[\w.@*-]*)/g;
const DOC = /\.(?:md|mdx|rst|txt)$/i;

export const isDocName = (file: string): boolean => DOC.test(file) && !/(?:^|\/)(?:CHANGELOG|HISTORY|LICENSE|NOTICE|CODE_OF_CONDUCT)[^/]*$/i.test(file);

function tokensOf(line: string): string[] {
	const withoutUrls = line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
	return [...withoutUrls.matchAll(TOKEN)].map((found) => (found[1] ?? found[2] ?? "").replace(/[/*.,;:)]+$/g, "")).filter((token) => token.includes("/") || /\.\w+$/.test(token));
}

export function readDocStatements(file: string, text: string, tracked: readonly string[]): ResolvedClaim[] {
	const dir = posix.dirname(file) === "." ? "" : posix.dirname(file), raw = [];
	for (const [index, line] of text.split("\n").entries()) {
		const tool = GENERATOR.exec(line)?.[1];
		if (tool === undefined || !GENERATING.test(line)) continue;
		for (const token of tokensOf(line)) raw.push({ tool: tool.toLowerCase(), path: token, baseDir: dir, file, line: index + 1, kind: "doc-statement" as const });
	}
	return resolveClaims(raw, tracked).claims;
}
