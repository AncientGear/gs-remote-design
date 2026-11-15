import assert from "node:assert/strict";
import { test } from "node:test";
import { startRelay } from "../src/relay.ts";
import { hashPassword } from "../src/password.ts";

test("native-form referrer policy preserves origin guards and existing sessions", async () => {
	const relay = await startRelay({ bind: "127.0.0.1", port: 0, username: "tester",
		passwordHash: await hashPassword("test-password"), allow: [], sessionHours: 1, target: () => undefined });
	const base = `http://127.0.0.1:${relay.port}`;
	const post = (path: string, origin: string, cookie = "") => fetch(base + path, {
		method: "POST", redirect: "manual", headers: { Origin: origin, Cookie: cookie },
		body: new URLSearchParams({ username: "tester", password: "test-password" }),
	});
	try {
		const page = await fetch(base + "/__remote/login");
		assert.equal(page.headers.get("referrer-policy"), "same-origin");
		assert.equal(page.headers.get("x-frame-options"), "DENY");
		const login = await post("/__remote/login", base);
		assert.equal(login.status, 303);
		const cookie = login.headers.get("set-cookie")!.split(";")[0];
		for (const origin of ["null", "http://foreign.example"]) {
			for (const path of ["/__remote/login", "/__remote/logout"]) {
				const rejected = await post(path, origin, cookie);
				assert.equal(rejected.status, 403);
				assert.equal(await rejected.text(), "Forbidden");
				assert.equal(rejected.headers.get("set-cookie"), null);
				assert.equal(relay.sessionCount(), 1);
			}
		}
		assert.equal((await fetch(base, { headers: { Cookie: cookie } })).status, 503);
		assert.equal((await post("/__remote/logout", base, cookie)).status, 303);
		assert.equal(relay.sessionCount(), 0);
	} finally { await relay.close(); }
});
