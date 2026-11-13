import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";

/** Persisted `/gentle:remote` settings. The password is only ever stored as a scrypt hash. */
export type RemoteConfig = {
	enabled: boolean;
	port: number;
	bind: string;
	username?: string;
	passwordHash?: string;
	allow: string[];
	sessionHours: number;
};

export const DEFAULT_CONFIG: Readonly<RemoteConfig> = Object.freeze({
	enabled: false,
	port: 30000,
	bind: "0.0.0.0",
	allow: [],
	sessionHours: 12,
});

export const CONFIG_FILE = "gentle-remote.json";

export class ConfigError extends Error {}

export function parsePort(value: string): number {
	if (!/^\d+$/.test(value)) throw new ConfigError(`port must be a whole number between 1024 and 65535, got "${value}"`);
	const port = Number(value);
	if (port < 1024 || port > 65535) throw new ConfigError(`port must be between 1024 and 65535, got ${port}`);
	return port;
}

export function parseBind(value: string): string {
	if (isIP(value) === 0) throw new ConfigError(`bind must be an IP address such as 0.0.0.0, 192.168.1.20 or ::, got "${value}"`);
	return value;
}

/** One allow-list entry: an IPv4/IPv6 address or a CIDR range. */
export function parseAllowEntry(value: string): string {
	const [address, prefix, extra] = value.split("/");
	const family = isIP(address ?? "");
	const valid = family !== 0 && extra === undefined && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)));
	if (!valid) throw new ConfigError(`allow entry must be an IP or CIDR such as 192.168.1.0/24, got "${value}"`);
	return value;
}

function validate(raw: unknown): RemoteConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config must be a JSON object");
	const value = { ...DEFAULT_CONFIG, ...(raw as Record<string, unknown>) } as Record<string, unknown>;
	if (typeof value.enabled !== "boolean") throw new ConfigError("enabled must be a boolean");
	if (typeof value.port !== "number") throw new ConfigError("port must be a number");
	parsePort(String(value.port));
	if (typeof value.bind !== "string") throw new ConfigError("bind must be a string");
	parseBind(value.bind);
	if (value.username !== undefined && (typeof value.username !== "string" || value.username === "")) throw new ConfigError("username must be a non-empty string");
	if (value.passwordHash !== undefined && typeof value.passwordHash !== "string") throw new ConfigError("passwordHash must be a string");
	if (!Array.isArray(value.allow) || !value.allow.every((entry) => typeof entry === "string")) throw new ConfigError("allow must be a list of strings");
	for (const entry of value.allow as string[]) parseAllowEntry(entry);
	if (typeof value.sessionHours !== "number" || !(value.sessionHours > 0 && value.sessionHours <= 24 * 30)) throw new ConfigError("sessionHours must be between 0 and 720");
	const config: RemoteConfig = { enabled: value.enabled, port: value.port, bind: value.bind, allow: [...(value.allow as string[])], sessionHours: value.sessionHours };
	if (value.username !== undefined) config.username = value.username as string;
	if (value.passwordHash !== undefined) config.passwordHash = value.passwordHash as string;
	return config;
}

/** A missing file is the defaults; an unreadable or invalid one is a ConfigError and is left untouched. */
export function loadConfig(path: string): RemoteConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG, allow: [] };
		throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new ConfigError(`${path} is not valid JSON; fix or delete it`);
	}
	try {
		return validate(raw);
	} catch (error) {
		throw new ConfigError(`${path}: ${(error as Error).message}`);
	}
}

/** Atomic write, owner-only permissions (it holds the password hash). */
export function saveConfig(path: string, config: RemoteConfig): void {
	const valid = validate(config);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(valid, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}
