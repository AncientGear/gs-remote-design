import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_PASSWORD_LENGTH, PasswordError, hashPassword, verifyPassword } from "../src/password.ts";

test("hashPassword never stores the plain password and verifies only the same one", async () => {
	const stored = await hashPassword("correct horse");
	assert.ok(stored.startsWith("scrypt$"));
	assert.ok(!stored.includes("correct horse"));
	assert.equal(await verifyPassword("correct horse", stored), true);
	assert.equal(await verifyPassword("correct hors", stored), false);
	assert.equal(await verifyPassword("", stored), false);
});

test("two hashes of the same password differ (random salt)", async () => {
	assert.notEqual(await hashPassword("same-password"), await hashPassword("same-password"));
});

test("a password shorter than the minimum is rejected", async () => {
	assert.equal(MIN_PASSWORD_LENGTH, 8);
	await assert.rejects(hashPassword("1234567"), PasswordError);
});

test("a malformed stored hash never verifies", async () => {
	for (const stored of ["", "plain", "scrypt$1$2", "scrypt$16384$8$1$zz$zz"]) assert.equal(await verifyPassword("whatever1", stored), false, stored);
});
