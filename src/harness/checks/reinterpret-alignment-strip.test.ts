import { describe, expect, it } from "vitest";
import { stripForLang } from "./reinterpret-alignment-strip.js";

describe("stripForLang — position and newline preservation", () => {
	it("keeps the character count and every newline for JS input", () => {
		const src = 'const a = "hello";\n// note\nconst b = 1;\n';
		const out = stripForLang(src, "js");
		expect(out.length).toBe(src.length);
		expect(out.split("\n").length).toBe(src.split("\n").length);
	});

	it("keeps the character count and every newline for Rust input", () => {
		const src = 'let s = "hi";\n/* a\n   b */\nlet n = 1;\n';
		const out = stripForLang(src, "rust");
		expect(out.length).toBe(src.length);
		expect(out.split("\n").length).toBe(src.split("\n").length);
	});
});

describe("stripForLang — comments", () => {
	it("blanks a JS line comment but keeps the code before it", () => {
		expect(stripForLang("let x = 1; // drop me", "js")).toBe("let x = 1;           ");
	});

	it("blanks a JS block comment", () => {
		expect(stripForLang("a /* mid */ b", "js")).toBe("a           b");
	});

	it("nests Rust block comments — an inner closer does not end the outer", () => {
		const out = stripForLang("a /* x /* y */ z */ b", "rust");
		expect(out).toBe("a                   b");
	});

	it("does not nest JS block comments — the first closer ends it", () => {
		const out = stripForLang("a /* x /* y */ z */ b", "js");
		expect(out.includes("z")).toBe(true);
	});
});

describe("stripForLang — strings", () => {
	it("blanks a double-quoted interior and keeps the delimiters", () => {
		expect(stripForLang('x = "abc";', "js")).toBe('x = "   ";');
	});

	it("blanks a template literal interior in JS", () => {
		expect(stripForLang("x = `ab`;", "js")).toBe("x = `  `;");
	});

	it("does not treat a backtick as a string opener in Rust", () => {
		expect(stripForLang("let x = `ab`;", "rust")).toBe("let x = `ab`;");
	});

	it("honors a backslash escape inside a JS string", () => {
		expect(stripForLang('a = "x\\"y";', "js")).toBe('a = "    ";');
	});

	it("stops a single-line JS string at end of line", () => {
		const out = stripForLang('a = "unterminated\nlet b = 1;', "js");
		expect(out.endsWith("let b = 1;")).toBe(true);
	});
});

describe("stripForLang — Rust single quotes", () => {
	it("consumes a char literal", () => {
		expect(stripForLang("let c = 'x';", "rust")).toBe("let c = ' ';");
	});

	it("consumes an escaped char literal", () => {
		expect(stripForLang("let c = '\\n';", "rust")).toBe("let c = '  ';");
	});

	it("leaves a lifetime live so the rest of the line survives", () => {
		const src = "fn f<'a>(x: &'a str) -> &'a str { x }";
		expect(stripForLang(src, "rust")).toBe(src);
	});
});

describe("stripForLang — Rust raw strings", () => {
	it("blanks a plain raw string body", () => {
		expect(stripForLang('let s = r"ab";', "rust")).toBe('let s = r"  ";');
	});

	it("blanks a hashed raw string body", () => {
		expect(stripForLang('let s = r#"a"b"#;', "rust")).toBe('let s = r#"   "#;');
	});

	it("leaves a raw identifier alone", () => {
		expect(stripForLang("let r#type = 1;", "rust")).toBe("let r#type = 1;");
	});

	it("leaves a bare identifier starting with r alone", () => {
		expect(stripForLang("let rows = 1;", "rust")).toBe("let rows = 1;");
	});
});

describe("stripForLang — JS regex versus division", () => {
	it("blanks a regex literal interior after an equals sign", () => {
		expect(stripForLang("const re = /a\"b/;", "js")).toBe("const re = /   /;");
	});

	it("blanks a regex literal after a return keyword", () => {
		expect(stripForLang("return /ab/;", "js")).toBe("return /  /;");
	});

	it("treats a slash after an identifier as division", () => {
		expect(stripForLang("const q = total/count;", "js")).toBe("const q = total/count;");
	});

	it("treats an unterminated slash on one line as division", () => {
		const src = "const q = a / b;\nconst r = 2;";
		expect(stripForLang(src, "js")).toBe(src);
	});

	it("keeps a slash inside a character class from closing the literal", () => {
		expect(stripForLang("const re = /[/x]y/;", "js")).toBe("const re = /     /;");
	});
});

describe("stripForLang — hash is never a comment marker", () => {
	it("keeps a JS private field live", () => {
		expect(stripForLang("this.#buf = 1;", "js")).toBe("this.#buf = 1;");
	});

	it("keeps a Rust attribute live", () => {
		expect(stripForLang("#[derive(Debug)]", "rust")).toBe("#[derive(Debug)]");
	});
});
