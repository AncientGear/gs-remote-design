import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const MIN_PASSWORD_LENGTH = 8;
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_BYTES = 32;

export class PasswordError extends Error {}

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
	return new Promise((resolve, reject) => scrypt(password, salt, KEY_BYTES, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key))));
}

/** `scrypt$N$r$p$<salt b64url>$<key b64url>`; the plain password is never stored. */
export async function hashPassword(password: string): Promise<string> {
	if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) throw new PasswordError(`password must have at least ${MIN_PASSWORD_LENGTH} characters`);
	const salt = randomBytes(16);
	const key = await derive(password, salt, PARAMS);
	return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = typeof stored === "string" ? stored.split("$") : [];
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [N, r, p] = parts.slice(1, 4).map(Number);
	if (![N, r, p].every(Number.isInteger) || N !== PARAMS.N || r !== PARAMS.r || p !== PARAMS.p) return false;
	const salt = Buffer.from(parts[4], "base64url");
	const expected = Buffer.from(parts[5], "base64url");
	if (salt.length < 16 || expected.length !== KEY_BYTES) return false;
	try {
		const key = await derive(typeof password === "string" ? password : "", salt, { N, r, p });
		return timingSafeEqual(key, expected);
	} catch {
		return false;
	}
}
