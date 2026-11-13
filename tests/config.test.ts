import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULT_CONFIG, loadConfig, parseAllowEntry, parseBind, parsePort, saveConfig } from "../src/config.ts";

const scratch = () => join(mkdtempSync(join(tmpdir(), "gsr-")), "gentle-remote.json");

test("a missing config file loads the defaults: off, 0.0.0.0:30000, no credentials", () => {
	const config = loadConfig(scratch());
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.equal(config.enabled, false);
	assert.equal(config.port, 30000);
	assert.equal(config.bind, "0.0.0.0");
	assert.equal(config.username, undefined);
	assert.equal(config.passwordHash, undefined);
});

test("saveConfig round-trips and writes the file readable by the owner only", () => {
	const path = scratch();
	const config = { ...DEFAULT_CONFIG, enabled: true, port: 31000, username: "saul", passwordHash: "scrypt$x", allow: ["10.0.0.0/8"] };
	saveConfig(path, config);
	assert.deepEqual(loadConfig(path), config);
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a corrupt config file is an error, never silently reset", () => {
	const path = scratch();
	writeFileSync(path, "{nope");
	assert.throws(() => loadConfig(path), ConfigError);
	assert.equal(readFileSync(path, "utf8"), "{nope");
});

test("a config with an invalid port is an error", () => {
	const path = scratch();
	writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, port: 80 }));
	assert.throws(() => loadConfig(path), ConfigError);
});

test("parsePort accepts 1024-65535 and rejects the rest", () => {
	assert.equal(parsePort("30000"), 30000);
	assert.equal(parsePort("1024"), 1024);
	assert.equal(parsePort("65535"), 65535);
	for (const bad of ["1023", "65536", "0", "-1", "30000.5", "abc", "", "3e4"]) assert.throws(() => parsePort(bad), ConfigError, bad);
});

test("parseBind accepts IP literals only", () => {
	assert.equal(parseBind("0.0.0.0"), "0.0.0.0");
	assert.equal(parseBind("192.168.1.20"), "192.168.1.20");
	assert.equal(parseBind("::"), "::");
	for (const bad of ["localhost", "999.1.1.1", "", "example.com"]) assert.throws(() => parseBind(bad), ConfigError, bad);
});

test("parseAllowEntry accepts IPs and CIDRs", () => {
	assert.equal(parseAllowEntry("192.168.1.0/24"), "192.168.1.0/24");
	assert.equal(parseAllowEntry("100.64.0.7"), "100.64.0.7");
	assert.equal(parseAllowEntry("fd00::1"), "fd00::1");
	assert.equal(parseAllowEntry("fd00::/8"), "fd00::/8");
	for (const bad of ["192.168.1.0/33", "fd00::/129", "nope", "10.0.0.0/", "/24"]) assert.throws(() => parseAllowEntry(bad), ConfigError, bad);
});
