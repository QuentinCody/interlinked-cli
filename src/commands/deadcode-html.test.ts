import { describe, expect, it } from "vitest";
import { htmlReferencedPaths } from "./deadcode-html.js";

const KNOWN = new Set(["proto/learn.js", "proto/site/academy.js", "proto/components/Button.jsx", "root.js", "other/x.js"]);

describe("htmlReferencedPaths", () => {
	it("P1: a script src is a reference, relative to the HTML file", () => {
		const html = '<script src="learn.js"></script>\n<script type="module" src="./site/academy.js?v=3"></script>';
		expect(htmlReferencedPaths(html, "proto/index.html", KNOWN)).toEqual(["proto/learn.js", "proto/site/academy.js"]);
	});
	it("P2: a quoted path in an inline script or a path list is a reference", () => {
		const html = "<script>const files = ['components/Button.jsx', \"../root.js\"];</script>";
		expect(htmlReferencedPaths(html, "proto/preview.html", KNOWN)).toEqual(["proto/components/Button.jsx", "root.js"]);
	});
	it("P3: a root-absolute src reads from the repo root", () => {
		expect(htmlReferencedPaths('<script src="/other/x.js"></script>', "proto/a.html", KNOWN)).toEqual(["other/x.js"]);
	});
	it("N1: a path to a file that does not exist is not a reference", () => {
		expect(htmlReferencedPaths('<script src="missing.js"></script>', "proto/a.html", KNOWN)).toEqual([]);
	});
	it("N2: a URL and a non-code file are not references", () => {
		const html = '<script src="https://cdn.example.com/learn.js"></script><link href="learn.css"><img src="learn.png">';
		expect(htmlReferencedPaths(html, "proto/a.html", KNOWN)).toEqual([]);
	});
	it("N3: a path that is only named in prose is not a reference", () => {
		expect(htmlReferencedPaths("<p>see learn.js for details</p>", "proto/a.html", KNOWN)).toEqual([]);
	});
});
