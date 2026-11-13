import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { hashPassword } from "../src/password.ts";
import { ipAllowed, startRelay, targetFromCanvasUrl, type Relay, type RelayOptions } from "../src/relay.ts";

const TOKEN = "abcdefghijklmnopqrstuvwx";
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
let canvas: Server;
let canvasPort = 0;
let seen: Seen[] = [];
let passwordHash = "";

before(async () => {
	passwordHash = await hashPassword("s3cret-pass");
	canvas = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			if (req.url === `/${TOKEN}/events`) {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.write("event: show\ndata: {}\n\n");
				return; // stays open like the real canvas stream
			}
			res.writeHead(200, {
				"Content-Type": "text/html",
				"Content-Security-Policy": `default-src 'self' http://${req.headers.host}; frame-ancestors http://127.0.0.1:${canvasPort} http://localhost:${canvasPort}`,
			});
			res.end(`canvas:${req.method}:${req.url}`);
		});
	});
	await new Promise<void>((resolve) => canvas.listen(0, "127.0.0.1", resolve));
	canvasPort = (canvas.address() as AddressInfo).port;
});
after(() => canvas.closeAllConnections() || canvas.close());

const relays: Relay[] = [];
after(async () => {
	for (const relay of relays) await relay.close();
});

async function relay(overrides: Partial<RelayOptions> = {}): Promise<Relay> {
	const started = await startRelay({
		bind: "127.0.0.1",
		port: 0,
		username: "saul",
		passwordHash,
		allow: [],
		sessionHours: 12,
		target: () => ({ port: canvasPort, token: TOKEN }),
		...overrides,
	});
	relays.push(started);
	return started;
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
function call(r: Relay, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: r.port, method, path, headers: { Host: `myhost:${r.port}`, ...headers } }, (res) => {
			let text = "";
			res.on("data", (chunk) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

const form = (username: string, password: string) => new URLSearchParams({ username, password }).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

async function login(r: Relay): Promise<string> {
	const reply = await call(r, "POST", "/__remote/login", FORM, form("saul", "s3cret-pass"));
	assert.equal(reply.status, 303);
	const cookie = String(reply.headers["set-cookie"]?.[0] ?? "");
	return cookie.split(";")[0];
}

test("targetFromCanvasUrl reads the loopback port and token of the canvas URL", () => {
	assert.deepEqual(targetFromCanvasUrl(`http://127.0.0.1:4100/${TOKEN}/d/login/`), { port: 4100, token: TOKEN });
	assert.equal(targetFromCanvasUrl("http://example.com:4100/abcdefghijklmnopqrstuvwx/"), undefined);
	assert.equal(targetFromCanvasUrl("http://127.0.0.1:4100/short/"), undefined);
	assert.equal(targetFromCanvasUrl(undefined), undefined);
});

test("ipAllowed: empty list allows all; entries match IPs, CIDRs and IPv4-mapped addresses", () => {
	assert.equal(ipAllowed("8.8.8.8", []), true);
	assert.equal(ipAllowed("192.168.1.9", ["192.168.1.0/24"]), true);
	assert.equal(ipAllowed("::ffff:192.168.1.9", ["192.168.1.0/24"]), true);
	assert.equal(ipAllowed("192.168.2.9", ["192.168.1.0/24"]), false);
	assert.equal(ipAllowed("fd00::5", ["fd00::/8"]), true);
	assert.equal(ipAllowed("100.64.0.7", ["100.64.0.7"]), true);
	assert.equal(ipAllowed(undefined, ["100.64.0.7"]), false);
});

test("the first visit asks for username and password before anything reaches the canvas", async () => {
	const r = await relay();
	seen = [];
	const root = await call(r, "GET", "/");
	assert.equal(root.status, 303);
	assert.equal(root.headers.location, "/__remote/login");
	const page = await call(r, "GET", "/__remote/login");
	assert.equal(page.status, 200);
	assert.match(page.body, /name="username"/);
	assert.match(page.body, /name="password" type="password"/);
	assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
	const api = await call(r, "GET", `/${TOKEN}/api/designs`);
	assert.equal(api.status, 401);
	assert.equal(seen.length, 0);
});

test("wrong username or password is refused with no session cookie", async () => {
	const r = await relay();
	for (const [user, pass] of [["saul", "wrong-pass"], ["other", "s3cret-pass"], ["", ""]]) {
		const reply = await call(r, "POST", "/__remote/login", FORM, form(user, pass));
		assert.equal(reply.status, 401, `${user}/${pass}`);
		assert.equal(reply.headers["set-cookie"], undefined);
		assert.match(reply.body, /Invalid username or password/);
	}
	assert.equal(r.sessionCount(), 0);
});

test("after 5 failures the IP is locked out even with the right password", async () => {
	const r = await relay();
	for (let i = 0; i < 5; i++) assert.equal((await call(r, "POST", "/__remote/login", FORM, form("saul", "nope-nope"))).status, 401);
	const locked = await call(r, "POST", "/__remote/login", FORM, form("saul", "s3cret-pass"));
	assert.equal(locked.status, 429);
	assert.equal(locked.headers["set-cookie"], undefined);
	assert.equal(r.sessionCount(), 0);
});

test("a correct login sets an HttpOnly session cookie and / leads to the canvas", async () => {
	const r = await relay();
	const reply = await call(r, "POST", "/__remote/login", FORM, form("saul", "s3cret-pass"));
	assert.equal(reply.status, 303);
	assert.equal(reply.headers.location, "/");
	const cookie = String(reply.headers["set-cookie"]?.[0]);
	assert.match(cookie, /^gsr_session=[A-Za-z0-9_-]{43}; /);
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /SameSite=Lax/);
	assert.match(cookie, /Max-Age=43200/);
	assert.doesNotMatch(cookie, /Secure/);
	const root = await call(r, "GET", "/", { Cookie: cookie.split(";")[0] });
	assert.equal(root.status, 303);
	assert.equal(root.headers.location, `/${TOKEN}/`);
});

test("a login form posted from another site is refused", async () => {
	const r = await relay();
	const reply = await call(r, "POST", "/__remote/login", { ...FORM, Origin: "http://evil.example" }, form("saul", "s3cret-pass"));
	assert.equal(reply.status, 403);
	assert.equal(r.sessionCount(), 0);
});

test("behind an HTTPS proxy the cookie is Secure", async () => {
	const r = await relay();
	const reply = await call(r, "POST", "/__remote/login", { ...FORM, "X-Forwarded-Proto": "https" }, form("saul", "s3cret-pass"));
	assert.match(String(reply.headers["set-cookie"]?.[0]), /; Secure/);
});

test("authenticated requests reach the canvas with its own Host and Origin, without the relay cookie", async () => {
	const r = await relay();
	const cookie = await login(r);
	seen = [];
	const page = await call(r, "GET", `/${TOKEN}/`, { Cookie: cookie });
	assert.equal(page.status, 200);
	assert.equal(page.body, `canvas:GET:/${TOKEN}/`);
	assert.equal(seen[0].headers.host, `127.0.0.1:${canvasPort}`);
	assert.equal(seen[0].headers.cookie, undefined);
	const post = await call(r, "POST", `/${TOKEN}/api/comments`, { Cookie: cookie, Origin: `http://myhost:${r.port}`, "Content-Type": "application/json" }, '{"a":1}');
	assert.equal(post.status, 200);
	assert.equal(seen[1].headers.origin, `http://127.0.0.1:${canvasPort}`);
	assert.equal(seen[1].body, '{"a":1}');
});

test("a POST from a foreign origin never reaches the canvas, even with a session", async () => {
	const r = await relay();
	const cookie = await login(r);
	seen = [];
	const post = await call(r, "POST", `/${TOKEN}/api/comments`, { Cookie: cookie, Origin: "http://evil.example" }, "{}");
	assert.equal(post.status, 403);
	assert.equal(seen.length, 0);
});

test("the canvas CSP is rewritten from loopback to the address the browser used", async () => {
	const r = await relay();
	const cookie = await login(r);
	const page = await call(r, "GET", `/${TOKEN}/files/demo/a.html`, { Cookie: cookie });
	const csp = String(page.headers["content-security-policy"]);
	assert.equal(csp, `default-src 'self' http://myhost:${r.port}; frame-ancestors http://myhost:${r.port} http://myhost:${r.port}`);
	assert.doesNotMatch(csp, /127\.0\.0\.1|localhost/);
});

test("artboard subresources load without the cookie (opaque origin); everything else needs it", async () => {
	const r = await relay();
	seen = [];
	for (const path of [`/${TOKEN}/files/demo/a.html`, `/${TOKEN}/system.html`, `/${TOKEN}/assets/inspector.js`]) {
		assert.equal((await call(r, "GET", path, { Origin: "null" })).status, 200, path);
	}
	assert.equal(seen.length, 3);
	for (const [method, path] of [["GET", `/${TOKEN}/`], ["GET", `/${TOKEN}/assets/canvas.js`], ["POST", `/${TOKEN}/files/demo/a.html`], ["GET", "/wrongtokenwrongtoken00/files/demo/a.html"]]) {
		assert.notEqual((await call(r, method, path)).status, 200, `${method} ${path}`);
	}
	assert.equal(seen.length, 3);
});

test("the live-reload stream is relayed as it happens", async () => {
	const r = await relay();
	const cookie = await login(r);
	const first = await new Promise<string>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: r.port, path: `/${TOKEN}/events`, headers: { Host: `myhost:${r.port}`, Cookie: cookie } }, (res) => {
			assert.equal(res.headers["content-type"], "text/event-stream");
			res.once("data", (chunk) => {
				resolve(String(chunk));
				req.destroy();
			});
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(first, "event: show\ndata: {}\n\n");
});

test("with the canvas closed, a signed-in visitor sees how to open it", async () => {
	const r = await relay({ target: () => undefined });
	const cookie = await login(r);
	const root = await call(r, "GET", "/", { Cookie: cookie });
	assert.equal(root.status, 503);
	assert.match(root.body, /\/gentle:design/);
});

test("a stale canvas token sends a signed-in visitor back to the current canvas", async () => {
	const r = await relay();
	const cookie = await login(r);
	const stale = await call(r, "GET", "/oldtokenoldtokenoldtoken/", { Cookie: cookie, Accept: "text/html" });
	assert.equal(stale.status, 303);
	assert.equal(stale.headers.location, "/");
});

test("the allow list refuses other IPs before the login page", async () => {
	const r = await relay({ allow: ["10.0.0.0/8"] });
	seen = [];
	assert.equal((await call(r, "GET", "/__remote/login")).status, 403);
	assert.equal((await call(r, "GET", `/${TOKEN}/files/demo/a.html`)).status, 403);
	assert.equal(seen.length, 0);
});

test("endSessions and logout end sessions; expired sessions ask again", async () => {
	let now = 1_000_000;
	const r = await relay({ now: () => now });
	const a = await login(r);
	r.endSessions();
	assert.equal((await call(r, "GET", "/", { Cookie: a })).headers.location, "/__remote/login");
	const b = await login(r);
	const out = await call(r, "POST", "/__remote/logout", { Cookie: b, Origin: `http://myhost:${r.port}` });
	assert.equal(out.status, 303);
	assert.match(String(out.headers["set-cookie"]?.[0]), /Max-Age=0/);
	assert.equal((await call(r, "GET", "/", { Cookie: b })).headers.location, "/__remote/login");
	const c = await login(r);
	now += 12 * 3600_000 + 1;
	assert.equal((await call(r, "GET", "/", { Cookie: c })).headers.location, "/__remote/login");
});

test("a port already in use is reported, not ignored", async () => {
	const r = await relay();
	await assert.rejects(relay({ port: r.port }), /EADDRINUSE/);
});
