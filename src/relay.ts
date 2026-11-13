import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, isIP, type AddressInfo } from "node:net";
import { verifyPassword } from "./password.ts";

/**
 * Remote relay for the gentle-design canvas. The canvas keeps listening on 127.0.0.1 and a random port;
 * this server listens on the configured bind/port, asks for a username and password first, and forwards
 * signed-in requests to the canvas with the Host and Origin it expects. CSP headers that name the loopback
 * origin are rewritten to the address the browser used, so artboards still frame inside the canvas.
 */

/** Where the canvas runs right now: its loopback port and the token every canvas route lives under. */
export type CanvasTarget = { port: number; token: string };

export type RelayOptions = {
	bind: string;
	port: number;
	username: string;
	passwordHash: string;
	allow: string[];
	sessionHours: number;
	/** The running canvas, or undefined when it is closed. Read on every request. */
	target: () => CanvasTarget | undefined;
	now?: () => number;
};

export type Relay = {
	port: number;
	close(): Promise<void>;
	/** Signs every browser out (password change, `/gentle:remote logout-all`). */
	endSessions(): void;
	sessionCount(): number;
	/** Applies new credentials, allow list or session length without closing the port; a credential change signs everyone out. */
	update(changes: Partial<Pick<RelayOptions, "username" | "passwordHash" | "allow" | "sessionHours">>): void;
};

const COOKIE = "gsr_session";
const LOGIN_PATH = "/__remote/login";
const LOGOUT_PATH = "/__remote/logout";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const MAX_SESSIONS = 100;
const MAX_TRACKED_IPS = 10_000;
const LOGIN_BODY_BYTES = 4096;
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"];
const PAGE_HEADERS = Object.freeze({
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
});

/** Reads the target out of the canvas URL the design service reports (`http://127.0.0.1:<port>/<token>/...`). */
export function targetFromCanvasUrl(url: string | undefined): CanvasTarget | undefined {
	if (typeof url !== "string") return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) return undefined;
	const port = Number(parsed.port);
	const token = parsed.pathname.split("/")[1] ?? "";
	if (!Number.isInteger(port) || port <= 0 || !TOKEN_SHAPE.test(token)) return undefined;
	return { port, token };
}

function normalizeIp(ip: string): string {
	return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** An empty list allows every address; otherwise the address must match one IP or CIDR entry. */
export function ipAllowed(ip: string | undefined, allow: readonly string[]): boolean {
	if (allow.length === 0) return true;
	if (!ip) return false;
	const address = normalizeIp(ip);
	const family = isIP(address);
	if (family === 0) return false;
	const list = new BlockList();
	for (const entry of allow) {
		const [base, prefix] = entry.split("/");
		const type = isIP(base) === 6 ? "ipv6" : "ipv4";
		if (prefix === undefined) list.addAddress(base, type);
		else list.addSubnet(base, Number(prefix), type);
	}
	return list.check(address, family === 6 ? "ipv6" : "ipv4");
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{font:16px system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#181b22;padding:2rem;border-radius:12px;width:min(22rem,90vw)}h1{font-size:1.2rem;margin:0 0 1rem}
label{display:block;margin:.75rem 0 .25rem}input{width:100%;box-sizing:border-box;padding:.5rem;border-radius:6px;border:1px solid #333;background:#0f1115;color:inherit}
button{margin-top:1.25rem;width:100%;padding:.6rem;border:0;border-radius:6px;background:#7c9cff;color:#0f1115;font-weight:600;cursor:pointer}
.error{color:#ff8080}code{background:#0f1115;padding:.1rem .3rem;border-radius:4px}
</style></head><body><main>${body}</main></body></html>`;
}

function loginPage(error?: string): string {
	return page(
		"Gentle Design · Sign in",
		`<h1>Gentle Design — remote</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="${LOGIN_PATH}">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>`,
	);
}

const CANVAS_CLOSED = page(
	"Gentle Design · Canvas closed",
	`<h1>The design canvas is not open</h1><p>Open it in Gentle Shell with <code>/gentle:design</code> (or ask the agent to open a design), then reload this page.</p>
<form method="post" action="${LOGOUT_PATH}"><button type="submit">Sign out</button></form>`,
);

function sha256(text: string): Buffer {
	return createHash("sha256").update(text).digest();
}

function readCookie(header: string | undefined, name: string): string | undefined {
	for (const part of (header ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return undefined;
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) return undefined;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
	if (!options.username || !options.passwordHash) throw new Error("a username and a password are required before the remote port opens");
	options = { ...options, allow: [...options.allow] };
	const now = options.now ?? Date.now;
	let sessionMs = options.sessionHours * 3600_000;
	let usernameDigest = sha256(options.username);
	const sessions = new Map<string, number>();
	const failures = new Map<string, { count: number; until: number }>();

	function sessionValid(req: IncomingMessage): boolean {
		const id = readCookie(req.headers.cookie, COOKIE);
		if (!id) return false;
		const expires = sessions.get(id);
		if (expires === undefined) return false;
		if (expires <= now()) {
			sessions.delete(id);
			return false;
		}
		return true;
	}

	function isHttps(req: IncomingMessage): boolean {
		return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase() === "https";
	}

	/** The origin the browser used to reach this relay. */
	function publicOrigin(req: IncomingMessage): string {
		return `${isHttps(req) ? "https" : "http"}://${req.headers.host ?? ""}`;
	}

	function sameOrigin(req: IncomingMessage): boolean {
		const origin = req.headers.origin;
		return origin === undefined || origin === publicOrigin(req);
	}

	function html(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
		res.writeHead(status, { ...PAGE_HEADERS, ...headers, "Content-Length": String(Buffer.byteLength(body)) });
		res.end(body);
	}

	function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
		res.writeHead(303, { "Cache-Control": "no-store", Location: location, "Content-Length": "0", ...headers });
		res.end();
	}

	function plain(res: ServerResponse, status: number, text: string): void {
		res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Length": String(Buffer.byteLength(text)) });
		res.end(text);
	}

	function lockedOut(ip: string): boolean {
		const entry = failures.get(ip);
		if (!entry) return false;
		if (entry.until <= now()) {
			failures.delete(ip);
			return false;
		}
		return entry.count >= MAX_FAILURES;
	}

	function recordFailure(ip: string): void {
		const entry = failures.get(ip);
		if (entry && entry.until > now()) entry.count += 1;
		else {
			if (failures.size >= MAX_TRACKED_IPS) {
				for (const [key, value] of failures) if (value.until <= now()) failures.delete(key);
				if (failures.size >= MAX_TRACKED_IPS) failures.delete(failures.keys().next().value as string);
			}
			failures.set(ip, { count: 1, until: now() + LOCKOUT_MS });
		}
	}

	async function handleLogin(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
		if (req.method === "GET" || req.method === "HEAD") return html(res, 200, loginPage());
		if (req.method !== "POST") return plain(res, 405, "Method not allowed");
		if (!sameOrigin(req)) return plain(res, 403, "Forbidden");
		if (lockedOut(ip)) return html(res, 429, loginPage("Too many failed attempts. Try again in 15 minutes."), { "Retry-After": String(LOCKOUT_MS / 1000) });
		const body = await readBody(req, LOGIN_BODY_BYTES);
		if (body === undefined) return plain(res, 413, "Request too large");
		const fields = new URLSearchParams(body);
		const username = fields.get("username") ?? "";
		const password = fields.get("password") ?? "";
		// The password check always runs, so a wrong username takes as long as a wrong password.
		const passwordOk = await verifyPassword(password, options.passwordHash);
		const userOk = timingSafeEqual(sha256(username), usernameDigest);
		if (!passwordOk || !userOk) {
			recordFailure(ip);
			return html(res, 401, loginPage("Invalid username or password."));
		}
		failures.delete(ip);
		if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
		const id = randomBytes(32).toString("base64url");
		sessions.set(id, now() + sessionMs);
		const cookie = `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionMs / 1000)}${isHttps(req) ? "; Secure" : ""}`;
		redirect(res, "/", { "Set-Cookie": [cookie] });
	}

	function handleLogout(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== "POST") return plain(res, 405, "Method not allowed");
		if (!sameOrigin(req)) return plain(res, 403, "Forbidden");
		const id = readCookie(req.headers.cookie, COOKIE);
		if (id) sessions.delete(id);
		redirect(res, LOGIN_PATH, { "Set-Cookie": [`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`] });
	}

	/** Paths an artboard loads from its opaque (sandboxed) origin, which sends no cookie; the canvas token guards them. */
	function artboardSubresource(rest: string[]): boolean {
		// Dot segments and encoded separators never qualify, so a path cannot climb out of files/ to the API.
		const clean = rest.every((segment) => {
			let decoded: string;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				return false;
			}
			return decoded !== "" && decoded !== "." && decoded !== ".." && !/[\\/]/.test(decoded);
		});
		if (!clean) return false;
		return rest[0] === "files" || (rest.length === 1 && rest[0] === "system.html") || (rest.length === 2 && rest[0] === "assets" && rest[1] === "inspector.js");
	}

	function forward(req: IncomingMessage, res: ServerResponse, target: CanvasTarget): void {
		const canvasOrigin = `http://127.0.0.1:${target.port}`;
		const headers: IncomingHttpHeaders = { ...req.headers };
		for (const name of [...HOP_BY_HOP, "cookie", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"]) delete headers[name];
		headers.host = `127.0.0.1:${target.port}`;
		if (req.headers.origin !== undefined && req.headers.origin !== "null") headers.origin = canvasOrigin;
		const visible = publicOrigin(req);
		const upstream = request({ host: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers }, (reply) => {
			const out: Record<string, string | string[] | number> = {};
			for (const [name, value] of Object.entries(reply.headers)) {
				if (value === undefined || HOP_BY_HOP.includes(name)) continue;
				out[name] = name === "content-security-policy" ? String(value).replaceAll(canvasOrigin, visible).replaceAll(`http://localhost:${target.port}`, visible) : value;
			}
			res.writeHead(reply.statusCode ?? 502, out);
			res.flushHeaders();
			reply.pipe(res);
		});
		upstream.on("error", () => {
			if (!res.headersSent) plain(res, 502, "The design canvas did not answer.");
			else res.destroy();
		});
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const ip = normalizeIp(req.socket.remoteAddress ?? "");
		if (!ipAllowed(ip, options.allow)) return plain(res, 403, "Forbidden");
		const path = (req.url ?? "/").split("?")[0];
		if (path === LOGIN_PATH) return handleLogin(req, res, ip);
		if (path === LOGOUT_PATH) return handleLogout(req, res);
		const signedIn = sessionValid(req);
		const target = options.target();
		const [, first, ...rest] = path.split("/");
		const underToken = target !== undefined && first === target.token;
		const readOnly = req.method === "GET" || req.method === "HEAD";
		if (!signedIn) {
			if (underToken && readOnly && artboardSubresource(rest)) return forward(req, res, target);
			if (path === "/" || (readOnly && String(req.headers.accept ?? "").includes("text/html"))) return redirect(res, LOGIN_PATH);
			return plain(res, 401, "Sign in first.");
		}
		if (path === "/") return target ? redirect(res, `/${target.token}/`) : html(res, 503, CANVAS_CLOSED);
		if (!underToken) return readOnly && String(req.headers.accept ?? "").includes("text/html") ? redirect(res, "/") : plain(res, 404, "Not found");
		if (!readOnly && !sameOrigin(req)) return plain(res, 403, "Forbidden");
		forward(req, res, target);
	}

	const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) plain(res, 500, "Internal error");
			else res.destroy();
		});
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 0; // the canvas live-reload stream stays open
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.bind, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	let closing: Promise<void> | undefined;
	return {
		port,
		close: () =>
			(closing ??= new Promise<void>((resolve) => {
				sessions.clear();
				server.close(() => resolve());
				server.closeAllConnections();
			})),
		endSessions: () => sessions.clear(),
		sessionCount: () => sessions.size,
		update(changes) {
			const credentials = (changes.username !== undefined && changes.username !== options.username) || (changes.passwordHash !== undefined && changes.passwordHash !== options.passwordHash);
			if (changes.username !== undefined) {
				options.username = changes.username;
				usernameDigest = sha256(changes.username);
			}
			if (changes.passwordHash !== undefined) options.passwordHash = changes.passwordHash;
			if (changes.allow !== undefined) options.allow = [...changes.allow];
			if (changes.sessionHours !== undefined) {
				options.sessionHours = changes.sessionHours;
				sessionMs = changes.sessionHours * 3600_000;
			}
			if (credentials) sessions.clear();
		},
	};
}
