import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import gentleRemote, { COMMAND_NAME, DESIGN_SERVICE_CHANNEL, DESIGN_SERVICE_SCHEMA } from "../extensions/gentle-remote.ts";

type Handler = (...args: any[]) => any;
type Command = { description?: string; getArgumentCompletions?: (prefix: string) => any; handler: (args: string, ctx: any) => Promise<void> };
const TOKEN = "abcdefghijklmnopqrstuvwx";

function fakePi() {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler[]>();
	const channels = new Map<string, Handler[]>();
	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		events: {
			on: (channel: string, handler: Handler) => {
				channels.set(channel, [...(channels.get(channel) ?? []), handler]);
				return () => {};
			},
			emit: (channel: string, data: unknown) => {
				for (const handler of channels.get(channel) ?? []) handler(data);
			},
		},
	};
	return { pi, commands, fire: async (event: string, payload: unknown, ctx: unknown) => { for (const h of handlers.get(event) ?? []) await h(payload, ctx); }, channels };
}

function fakeCtx(inputs: Array<string | undefined> = [], hasUI = true) {
	const notes: Array<{ message: string; level: string }> = [];
	return {
		notes,
		ctx: {
			hasUI,
			cwd: "/tmp",
			ui: {
				notify: (message: string, level = "info") => notes.push({ message, level }),
				input: async () => inputs.shift(),
			},
		},
	};
}

/** A design-service owner like gentle-design's: answers discovery and lets the test drive transitions. */
function fakeDesignOwner(pi: ReturnType<typeof fakePi>["pi"]) {
	const observers = new Set<Handler>();
	let url: string | undefined;
	pi.events.on(DESIGN_SERVICE_CHANNEL, (payload: any) => {
		payload.respond({
			schema: DESIGN_SERVICE_SCHEMA,
			read: async () => ({ running: url !== undefined, slug: null, connectedClients: 0 }),
			url: () => url,
			listDesigns: () => [],
			observe: (_options: unknown, cb: Handler) => {
				observers.add(cb);
				return () => observers.delete(cb);
			},
			dispose: () => observers.clear(),
		});
	});
	return {
		open(next: string) {
			url = next;
			for (const cb of observers) cb({ transition: "open", running: true, slug: null, connectedClients: 0, url: next });
		},
		stop() {
			url = undefined;
			for (const cb of observers) cb({ transition: "stop", running: false, slug: null, connectedClients: 0 });
		},
	};
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `box:${port}`, ...headers } }, (res) => {
			res.resume();
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
		});
		req.on("error", reject);
		req.end(body);
	});
}
const listening = (port: number) => call(port, "GET", "/__remote/login").then(() => true, () => false);
const loginForm = (password: string) => new URLSearchParams({ username: "saul", password }).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup) await fn();
	cleanup = [];
});

async function setup() {
	const configPath = join(mkdtempSync(join(tmpdir(), "gsr-ext-")), "gentle-remote.json");
	const port = await freePort();
	const fake = fakePi();
	const owner = fakeDesignOwner(fake.pi);
	gentleRemote(fake.pi as any, { configPath, bind: "127.0.0.1" });
	const command = fake.commands.get(COMMAND_NAME)!;
	const run = async (args: string, inputs: Array<string | undefined> = [], hasUI = true) => {
		const { ctx, notes } = fakeCtx(inputs, hasUI);
		await command.handler(args, ctx);
		return notes;
	};
	cleanup.push(() => fake.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, fakeCtx().ctx));
	return { configPath, port, fake, owner, command, run, config: () => JSON.parse(readFileSync(configPath, "utf8")) };
}

async function configured() {
	const s = await setup();
	await s.run(`port ${s.port}`);
	await s.run("user saul");
	await s.run("password", ["s3cret-pass"]);
	return s;
}

test("registers /gentle:remote with subcommand completions", async () => {
	const { command } = await setup();
	assert.equal(COMMAND_NAME, "gentle:remote");
	assert.match(String(command.description), /remote/i);
	const items = await command.getArgumentCompletions!("p");
	assert.deepEqual(items.map((i: any) => i.value), ["port", "password"]);
});

test("on refuses to open the port without username and password", async () => {
	const s = await setup();
	await s.run(`port ${s.port}`);
	const notes = await s.run("on");
	assert.equal(notes.at(-1)?.level, "error");
	assert.match(notes.at(-1)!.message, /\/gentle:remote user <name>/);
	assert.match(notes.at(-1)!.message, /\/gentle:remote password/);
	assert.equal(s.config().enabled, false);
	assert.equal(await listening(s.port), false);
});

test("user, password and port are stored (password only as a hash) and on opens the port", async () => {
	const s = await configured();
	const stored = readFileSync(s.configPath, "utf8");
	assert.doesNotMatch(stored, /s3cret-pass/);
	assert.equal(s.config().username, "saul");
	assert.match(s.config().passwordHash, /^scrypt\$/);
	assert.equal(s.config().port, s.port);
	const notes = await s.run("on");
	assert.equal(notes.at(-1)?.level, "info");
	assert.match(notes.at(-1)!.message, new RegExp(`http://127\\.0\\.0\\.1:${s.port}/`));
	assert.equal(s.config().enabled, true);
	assert.equal(await listening(s.port), true);
	assert.equal((await call(s.port, "GET", "/")).headers.location, "/__remote/login");
});

test("invalid port, user, bind or short password are rejected and leave the config unchanged", async () => {
	const s = await configured();
	const before = readFileSync(s.configPath, "utf8");
	for (const args of ["port 80", "port abc", "user", "user two words", "bind nope", "allow 10.0.0.0/99"]) {
		const notes = await s.run(args);
		assert.equal(notes.at(-1)?.level, "error", args);
	}
	assert.equal((await s.run("password", ["short"])).at(-1)?.level, "error");
	assert.equal((await s.run("password", [undefined])).at(-1)?.level, "warning");
	assert.equal(readFileSync(s.configPath, "utf8"), before);
});

test("password needs the interactive prompt; it is never taken from the command line", async () => {
	const s = await configured();
	const before = readFileSync(s.configPath, "utf8");
	const inline = await s.run("password s3cret-other");
	assert.equal(inline.at(-1)?.level, "error");
	const headless = await s.run("password", ["s3cret-other"], false);
	assert.equal(headless.at(-1)?.level, "error");
	assert.equal(readFileSync(s.configPath, "utf8"), before);
});

test("a signed-in browser reaches the canvas the design service reports, and follows it when it closes", async () => {
	const s = await configured();
	await s.run("on");
	const login = await call(s.port, "POST", "/__remote/login", FORM, loginForm("s3cret-pass"));
	const cookie = String(login.headers["set-cookie"]?.[0]).split(";")[0];
	assert.equal((await call(s.port, "GET", "/", { Cookie: cookie })).status, 503);
	s.owner.open(`http://127.0.0.1:4100/${TOKEN}/d/demo/`);
	assert.equal((await call(s.port, "GET", "/", { Cookie: cookie })).headers.location, `/${TOKEN}/`);
	s.owner.stop();
	assert.equal((await call(s.port, "GET", "/", { Cookie: cookie })).status, 503);
	const status = await s.run("");
	assert.match(status.at(-1)!.message, /canvas: closed/i);
});

test("changing the password signs every browser out; logout-all does too", async () => {
	const s = await configured();
	await s.run("on");
	s.owner.open(`http://127.0.0.1:4100/${TOKEN}/`);
	const signIn = async (password: string) => String((await call(s.port, "POST", "/__remote/login", FORM, loginForm(password))).headers["set-cookie"]?.[0]).split(";")[0];
	const a = await signIn("s3cret-pass");
	await s.run("password", ["n3w-password"]);
	assert.equal((await call(s.port, "GET", "/", { Cookie: a })).headers.location, "/__remote/login");
	const b = await signIn("n3w-password");
	assert.equal((await call(s.port, "GET", "/", { Cookie: b })).headers.location, `/${TOKEN}/`);
	await s.run("logout-all");
	assert.equal((await call(s.port, "GET", "/", { Cookie: b })).headers.location, "/__remote/login");
});

test("off closes the port; session end closes it but keeps it enabled for the next session", async () => {
	const s = await configured();
	await s.run("on");
	await s.run("off");
	assert.equal(s.config().enabled, false);
	assert.equal(await listening(s.port), false);
	await s.run("on");
	await s.fake.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, fakeCtx().ctx);
	assert.equal(await listening(s.port), false);
	assert.equal(s.config().enabled, true);
	await s.fake.fire("session_start", { type: "session_start" }, fakeCtx().ctx);
	assert.equal(await listening(s.port), true);
});

test("allow adds and clears entries; a running relay picks them up", async () => {
	const s = await configured();
	await s.run("on");
	await s.run("allow 10.0.0.0/8");
	assert.deepEqual(s.config().allow, ["10.0.0.0/8"]);
	assert.equal((await call(s.port, "GET", "/__remote/login")).status, 403);
	await s.run("allow clear");
	assert.deepEqual(s.config().allow, []);
	assert.equal((await call(s.port, "GET", "/__remote/login")).status, 200);
});

test("a port already in use is reported and the relay stays off", async () => {
	const s = await configured();
	const blocker = createServer();
	await new Promise<void>((resolve) => blocker.listen(s.port, "127.0.0.1", resolve));
	cleanup.push(() => new Promise((resolve) => blocker.close(() => resolve())));
	const notes = await s.run("on");
	assert.equal(notes.at(-1)?.level, "error");
	assert.match(notes.at(-1)!.message, new RegExp(`${s.port}.*in use`));
});

test("a missing config file is not created by just reading the status", async () => {
	const s = await setup();
	const notes = await s.run("status");
	assert.match(notes.at(-1)!.message, /off/);
	assert.equal(existsSync(s.configPath), false);
});
