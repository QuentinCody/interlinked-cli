import { describe, expect, it } from "vitest";
import { INTERPRETER_NETWORK_APIS, scanProgramForNetwork } from "./network-interpreter-apis.js";

describe("scanProgramForNetwork — positive (must fire)", () => {
	it("P1: python urlopen on a URL from the environment (no URL literal at all)", () => {
		const body = "import os, urllib.request\nurllib.request.urlopen(os.environ['U']).read()";
		expect(scanProgramForNetwork("python3", body)).toMatchObject({ hosts: [], hostsUnknown: true, loopbackOnly: false });
	});
	it("P2: node fetch on a URL from the environment", () => {
		expect(scanProgramForNetwork("node", "fetch(process.env.U).then(r => r.text())")?.api).toBe("fetch(");
	});
	it("P3: python requests call names its literal host", () => {
		expect(scanProgramForNetwork("python3", "import requests\nrequests.get('https://api.example.com/x')")).toMatchObject({
			hosts: ["api.example.com"], hostsUnknown: false,
		});
	});
	it("P4: ruby Net::HTTP and perl LWP are network APIs", () => {
		expect(scanProgramForNetwork("ruby", "require 'net/http'; Net::HTTP.get(URI(ARGV[0]))")).not.toBeNull();
		expect(scanProgramForNetwork("perl", "use LWP::Simple; print get($ARGV[0]);")).not.toBeNull();
	});
	it("P5: a program that shells out to curl is a network program", () => {
		expect(scanProgramForNetwork("python3", "import subprocess\nsubprocess.run(['curl', '-s', u])")?.api).toBe("shell-out to a network verb");
	});
	it("P6: node require('https').get and a raw python socket connect", () => {
		expect(scanProgramForNetwork("node", 'require("https").get(u, cb)')).not.toBeNull();
		expect(scanProgramForNetwork("python", "import socket\ns=socket.socket()\ns.connect((h, 443))")).not.toBeNull();
	});
	it("P7: an API call on a loopback literal is reported as loopback-only", () => {
		expect(scanProgramForNetwork("python3", "from urllib.request import urlopen\nurlopen('http://127.0.0.1:8080/')")).toMatchObject({
			loopbackOnly: true,
		});
	});
});

describe("scanProgramForNetwork — negative (must not fire)", () => {
	it("N1: a URL string alone is not network (python string replace)", () => {
		expect(scanProgramForNetwork("python3", "print('https://antithesis.com/blog/x'.replace('https://antithesis.com', ''))")).toBeNull();
	});
	it("N2: urllib.parse and an XML namespace URI are local", () => {
		const body = "import urllib.parse, xml.etree.ElementTree as ET\nNS={'a':'http://www.w3.org/2005/Atom'}\nprint(urllib.parse.urlparse(u).path)";
		expect(scanProgramForNetwork("python3", body)).toBeNull();
	});
	it("N3: the word 'requests' in prose is not the requests library", () => {
		expect(scanProgramForNetwork("python3", "print('handled 3 requests.')")).toBeNull();
	});
	it("N4: reading a dependency name from package.json is not axios", () => {
		expect(scanProgramForNetwork("node", "console.log(require('./package.json').dependencies.axios)")).toBeNull();
	});
	it("N5: subprocess running a local tool is not a shell-out to the network", () => {
		expect(scanProgramForNetwork("python3", "import subprocess\nsubprocess.run(['rg', '-n', 'https://x', 'notes.md'])")).toBeNull();
	});
	it("N6: an unknown interpreter has no API table", () => {
		expect(scanProgramForNetwork("lua", "fetch(x)")).toBeNull();
	});
});

describe("INTERPRETER_NETWORK_APIS", () => {
	it("covers the four inline-program languages", () => {
		expect(Object.keys(INTERPRETER_NETWORK_APIS).sort()).toEqual(["node", "perl", "python", "ruby"]);
	});
});
