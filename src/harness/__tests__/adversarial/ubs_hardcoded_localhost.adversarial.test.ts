// Independent adversarial review of the `ubs_hardcoded_localhost` pre_block
// check (2026-10-21, round 3). Probe:
// `scratch/2026-10-21-adversarial/ubs_hardcoded_localhost.probe.mts` (cases in
// `ubs_hardcoded_localhost.round3.cases.json`). Each negative fired before the
// detector was refined; each is a declared default, a bind address, an env
// fallback, a dev gate or a host allowlist, not a baked endpoint.

import { describe, expect, it } from "vitest";
import { checkUbsHardcodedLocalhost } from "../../checks/ubs-language-specific/cross-language-checks.js";

const run = (lines: string[], file: string) => checkUbsHardcodedLocalhost(lines.join("\n"), file);

describe("ubs_hardcoded_localhost — negative (must not fire)", () => {
	it("N1: Python parameter default in black's one-parameter-per-line layout", () => {
		const lines = [
			"class Cache:",
			"    def __init__(",
			"        self,",
			'        host: str = "localhost",',
			"        port: int = 6379,",
			"    ) -> None:",
			"        self.host = host",
		];
		expect(run(lines, "pkg/redis_client.py")).toEqual([]);
	});

	it("N2: TS constructor parameter default in prettier's multi-line layout", () => {
		const lines = [
			"export class ApiClient {",
			"\tconstructor(",
			'\t\tprivate readonly baseUrl = "http://localhost:8080",',
			"\t\tprivate readonly timeoutMs = 5000,",
			"\t) {}",
			"}",
		];
		expect(run(lines, "src/lib/api-client.ts")).toEqual([]);
	});

	it("N3: Kotlin primary-constructor default on its own line", () => {
		const lines = ["class ApiClient(", '    private val baseUrl: String = "http://localhost:8080",', ")"];
		expect(run(lines, "app/src/main/kotlin/ApiClient.kt")).toEqual([]);
	});

	it("N4: Go flag.String / flag.StringVar defaults", () => {
		expect(run(['var addr = flag.String("addr", "localhost:8080", "http service address")'], "cmd/client/main.go")).toEqual([]);
		expect(
			run(['flag.StringVar(&serverURL, "server", "http://localhost:8080", "server URL")'], "cmd/client/main.go"),
		).toEqual([]);
	});

	it("N5: Typer option default in a multi-line signature", () => {
		const lines = ["def main(", '    url: str = typer.Option("http://localhost:8000", help="API URL"),', "):", "    run(url)"];
		expect(run(lines, "pkg/cli.py")).toEqual([]);
	});

	it("N6: Go 1.22 cmp.Or env fallback", () => {
		expect(run(['addr := cmp.Or(os.Getenv("ADDR"), "http://localhost:8080")'], "internal/client/client.go")).toEqual([]);
	});

	it("N7: Python HTTPServer loopback bind tuple (OAuth callback server)", () => {
		expect(run(['server = HTTPServer(("127.0.0.1", 0), CallbackHandler)'], "pkg/auth/callback.py")).toEqual([]);
	});

	it("N8: Go http.Server Addr is the listen address", () => {
		const lines = ['srv := &http.Server{Addr: "127.0.0.1:8080", Handler: mux}', "log.Fatal(srv.ListenAndServe())"];
		expect(run(lines, "internal/server/server.go")).toEqual([]);
	});

	it("N9: JDK HttpServer.create loopback bind", () => {
		const lines = ['HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);'];
		expect(run(lines, "src/main/java/com/x/Callback.java")).toEqual([]);
	});

	it("N10: Spring @Value placeholder with a default", () => {
		const lines = ['@Value("${api.url:http://localhost:8080}")', "private String apiUrl;"];
		expect(run(lines, "src/main/java/com/x/ApiClient.java")).toEqual([]);
	});

	it("N11: Go struct tag envDefault", () => {
		const lines = ["type Settings struct {", '\tAddr string `env:"ADDR" envDefault:"localhost:8080"`', "}"];
		expect(run(lines, "internal/settings/settings.go")).toEqual([]);
	});

	it("N12: Electron app.isPackaged dev gate", () => {
		const lines = ['const url = app.isPackaged ? `file://${indexHtml}` : "http://localhost:5173";', "win.loadURL(url);"];
		expect(run(lines, "src/main/window.ts")).toEqual([]);
	});

	it("N13: webpack devServer host", () => {
		const lines = ["module.exports = {", "\tdevServer: {", '\t\thost: "localhost",', "\t\tport: 3000,", "\t},", "};"];
		expect(run(lines, "webpack.dev.js")).toEqual([]);
	});

	it("N14: pydantic BaseSettings field default (the env overrides it by name)", () => {
		const lines = ["class Settings(BaseSettings):", '    api_url: str = "http://localhost:8000"'];
		expect(run(lines, "app/settings.py")).toEqual([]);
	});

	it("N15: Django ALLOWED_HOSTS allowlist", () => {
		expect(run(['ALLOWED_HOSTS = ["localhost", "127.0.0.1"]'], "mysite/settings.py")).toEqual([]);
	});
});

describe("ubs_hardcoded_localhost — positive (must fire)", () => {
	it("P1: a multi-line CALL argument is not a signature default", () => {
		const lines = ["const client = createClient(", '\t"http://localhost:8080",', "\t5000,", ");"];
		expect(run(lines, "src/lib/api-client.ts")).toHaveLength(1);
	});

	it("P2: a Python multi-line call keyword argument inside a function body", () => {
		const lines = ["def make_cache():", "    r = redis.Redis(", '        host="localhost",', "        port=6379,", "    )"];
		expect(run(lines, "pkg/cache.py")).toEqual([{ line: 3, text: 'host="localhost",' }]);
	});

	it("P3: a class field after a closed multi-line constructor", () => {
		const lines = [
			"export class ApiClient {",
			"\tconstructor(",
			"\t\tprivate readonly timeoutMs = 5000,",
			"\t) {}",
			'\tprivate base = "http://localhost:8080";',
			"}",
		];
		expect(run(lines, "src/lib/api-client.ts")).toEqual([{ line: 5, text: 'private base = "http://localhost:8080";' }]);
	});

	it("P4: a Go client call dials the literal", () => {
		const lines = ['resp, err := http.Get("http://localhost:8080/health")'];
		expect(run(lines, "internal/client/client.go")).toHaveLength(1);
	});

	it("P5: an annotated field outside a BaseSettings class", () => {
		const lines = ["class Client:", '    api_url: str = "http://localhost:8000"'];
		expect(run(lines, "app/client.py")).toHaveLength(1);
	});

	it("P6: a client socket connect to a loopback InetSocketAddress", () => {
		const lines = ['socket.connect(new InetSocketAddress("localhost", 8080));'];
		expect(run(lines, "src/main/java/com/x/Client.java")).toHaveLength(1);
	});
});
