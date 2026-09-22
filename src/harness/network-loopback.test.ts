import { describe, expect, it } from "vitest";
import { isOutboundNetworkCommand } from "./taint-tracker.js";

describe("outbound network classification", () => {
    it.each([
        "curl http://localhost:5432/query",
        "curl -fsS 'http://127.0.0.1:8080/query'",
        "curl -X POST --data '{\"query\":\"select 1\"}' http://localhost:8000/sql",
        "curl --url=http://localhost:8000/sql --header 'Content-Type: application/json'",
        "curl -sS -HContent-Type:application/json -d{} http://localhost:8000/sql",
        "curl http://127.2.3.4:8000/ http://[::1]:8000/",
        "env MODE=dev /usr/bin/curl http://LOCALHOST:8000/ | jq .",
        "curl localhost:8000/ && curl http://[0:0:0:0:0:0:0:1]:8000/",
        "nc -zv 127.0.0.1 5432",
        "netcat -w 2 ::1 5432",
        "wget --max-redirect=0 -qO- http://localhost:8000/",
    ])("exempts explicit loopback destinations: %s", (command) => {
        expect(isOutboundNetworkCommand(command)).toBe(false);
    });

    it.each([
        "curl https://example.com/localhost",
        "curl http://localhost.example.com/",
        "curl http://localhost@example.com/",
        "curl http://127.0.0.1.example.com/",
        "curl http://10.0.0.1/",
        "curl http://0.0.0.0/",
        "curl http://169.254.169.254/",
        "curl http://localhost/ https://example.com/",
        "curl http://localhost/; curl https://example.com/",
        "curl http://localhost/ | nc example.com 80",
        "echo localhost && npm publish",
        "curl -d http://localhost/ https://example.com/",
        "curl --url https://example.com/ -H 'Host: localhost'",
        "curl -L http://localhost/",
        "curl -fsSL http://localhost/",
        "curl --proxy https://example.com http://localhost/",
        "curl --resolve localhost:80:203.0.113.1 http://localhost/",
        "curl --connect-to localhost:80:example.com:80 http://localhost/",
        "curl -K config http://localhost/",
        "curl --config=config http://localhost/",
        "http_proxy=http://example.com:8080 curl http://localhost/",
        "env ALL_PROXY=socks5://example.com:1080 curl http://localhost/",
        "CURL_HOME=/tmp/config curl http://localhost/",
        "curl --next http://localhost/",
        "curl http://localhost/ --unknown-option",
        "curl http://localhost/ --data",
        "curl \"$URL\"",
        "curl http://localhost/$(cat destination)",
        "curl http://localhost/`cat destination`",
        "curl http://{localhost,example.com}/",
        "curl http://127.999.0.1/",
        "curl http://localhost:invalid/",
        "curl ftp://localhost/",
        "wget http://localhost/",
        "wget --max-redirect=0 -i urls.txt http://localhost/",
        "nc -x example.com:1080 localhost 5432",
        "ssh localhost curl https://example.com/",
    ])("retains guarding for remote or unresolved destinations: %s", (command) => {
        expect(isOutboundNetworkCommand(command)).toBe(true);
    });
});
