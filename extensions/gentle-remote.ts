import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, ConfigError, loadConfig, parseAllowEntry, parseBind, parsePort, saveConfig, type RemoteConfig } from "../src/config.ts";
import { PasswordError, hashPassword, MIN_PASSWORD_LENGTH } from "../src/password.ts";
import { startRelay, targetFromCanvasUrl, type Relay } from "../src/relay.ts";

/**
 * /gentle:remote — reach the gentle-design canvas from another machine through <ip/host>:<port>.
 * The canvas itself stays on 127.0.0.1; this extension discovers it through gentle-design's
 * design service seam and runs a password-protected relay on the configured port.
 */

export const COMMAND_NAME = "gentle:remote";
/** gentle-design's design service seam (gentle-shell lib/desktop-rpc-design.ts). */
export const DESIGN_SERVICE_CHANNEL = "gentle:desktop:design-service";
export const DESIGN_SERVICE_SCHEMA = "gentle-pi.desktop-design-service/v1";

type DesignService = {
	schema: string;
	url(): string | undefined;
	observe(options: { includeUrl?: boolean }, onTransition: (transition: { transition: string; url?: string }) => void): () => void;
	dispose(): void;
};

export type GentleRemoteDeps = {
	/** Where the settings live; defaults to `<agent dir>/gentle-remote.json`. */
	configPath?: string;
	/** Tests only: listen on this address whatever the config says. */
	bind?: string;
};

const SUBCOMMANDS: ReadonlyArray<{ value: string; label: string; description: string }> = [
	{ value: "status", label: "status", description: "Show the remote settings, the URL and whether the canvas is open" },
	{ value: "on", label: "on", description: "Open the remote port (needs user and password)" },
	{ value: "off", label: "off", description: "Close the remote port" },
	{ value: "port", label: "port <1024-65535>", description: "Port the remote relay listens on (default 30000)" },
	{ value: "bind", label: "bind <ip>", description: "Address to listen on: 0.0.0.0 (all), :: or one IP such as a LAN/VPN address" },
	{ value: "user", label: "user <name>", description: "Username asked on the first visit" },
	{ value: "password", label: "password", description: "Set the password (asked in a prompt, stored as a hash)" },
	{ value: "allow", label: "allow <ip|cidr|clear>", description: "Only accept these IPs/CIDRs (empty: any)" },
	{ value: "logout-all", label: "logout-all", description: "Sign every browser out" },
	{ value: "help", label: "help", description: "Show the subcommands" },
];

const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;

function usage(): string {
	return [`Usage: /${COMMAND_NAME} <subcommand>`, ...SUBCOMMANDS.map((s) => `  ${s.label.padEnd(24)} ${s.description}`)].join("\n");
}

async function defaultConfigPath(): Promise<string> {
	try {
		const pi = (await import("@earendil-works/pi-coding-agent")) as { getAgentDir?: () => string };
		if (typeof pi.getAgentDir === "function") return join(pi.getAgentDir(), CONFIG_FILE);
	} catch {
		/* not resolvable outside Pi: fall back below */
	}
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), CONFIG_FILE);
}

/** The addresses a user can type in a browser: the bind IP, or every external interface for 0.0.0.0/::. */
function reachableHosts(bind: string): string[] {
	if (bind !== "0.0.0.0" && bind !== "::") return [bind.includes(":") ? `[${bind}]` : bind];
	const hosts: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.internal) continue;
			if (entry.family === "IPv4") hosts.push(entry.address);
			else if (bind === "::" && !entry.address.startsWith("fe80")) hosts.push(`[${entry.address}]`);
		}
	}
	return hosts.length > 0 ? hosts : ["<server-ip>"];
}

export default function gentleRemote(pi: ExtensionAPI, deps: GentleRemoteDeps = {}): void {
	let configPathPromise: Promise<string> | undefined;
	const configPath = () => (configPathPromise ??= deps.configPath ? Promise.resolve(deps.configPath) : defaultConfigPath());
	let relay: Relay | undefined;
	let relayFor: { bind: string; port: number } | undefined;
	let service: DesignService | undefined;
	let unobserve: (() => void) | undefined;
	let canvasUrl: string | undefined;

	/** Ask gentle-design for its design service; it answers synchronously when the extension is loaded. */
	function attachDesign(ctx: ExtensionContext): void {
		if (service || !pi.events) return;
		pi.events.emit(DESIGN_SERVICE_CHANNEL, {
			context: ctx,
			respond(candidate: DesignService) {
				if (service || !candidate || candidate.schema !== DESIGN_SERVICE_SCHEMA || typeof candidate.observe !== "function") return;
				service = candidate;
				canvasUrl = candidate.url();
				unobserve = candidate.observe({ includeUrl: true }, (transition) => {
					canvasUrl = transition.transition === "stop" ? undefined : (transition.url ?? canvasUrl);
				});
			},
		});
	}

	function detachDesign(): void {
		unobserve?.();
		service?.dispose();
		unobserve = undefined;
		service = undefined;
		canvasUrl = undefined;
	}

	async function stopRelay(): Promise<void> {
		const current = relay;
		relay = undefined;
		relayFor = undefined;
		await current?.close();
	}

	/** (Re)starts the relay from the config; the old sessions end with it. */
	async function startFromConfig(config: RemoteConfig): Promise<void> {
		await stopRelay();
		const bind = deps.bind ?? config.bind;
		try {
			relay = await startRelay({
				bind,
				port: config.port,
				username: config.username!,
				passwordHash: config.passwordHash!,
				allow: config.allow,
				sessionHours: config.sessionHours,
				target: () => targetFromCanvasUrl(canvasUrl),
			});
			relayFor = { bind, port: config.port };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EADDRINUSE") throw new ConfigError(`port ${config.port} is already in use on ${bind}; choose another with /${COMMAND_NAME} port <n>`);
			if (code === "EACCES") throw new ConfigError(`no permission to listen on ${bind}:${config.port}`);
			if (code === "EADDRNOTAVAIL") throw new ConfigError(`${bind} is not an address of this machine; check /${COMMAND_NAME} bind`);
			throw error;
		}
	}

	function missingCredentials(config: RemoteConfig): string | undefined {
		const missing = [!config.username && `/${COMMAND_NAME} user <name>`, !config.passwordHash && `/${COMMAND_NAME} password`].filter(Boolean);
		return missing.length > 0 ? `Set a username and password first: ${missing.join(" and ")}` : undefined;
	}

	function status(config: RemoteConfig): string {
		const bind = relayFor?.bind ?? deps.bind ?? config.bind;
		const urls = reachableHosts(bind).map((host) => `http://${host}:${relayFor?.port ?? config.port}/`);
		return [
			`Remote design access: ${relay ? "on" : config.enabled ? "enabled, not running" : "off"}`,
			`  listen: ${bind}:${config.port}`,
			`  user: ${config.username ?? "(not set)"} · password: ${config.passwordHash ? "set" : "(not set)"}`,
			`  allow: ${config.allow.length > 0 ? config.allow.join(", ") : "any IP"}`,
			`  canvas: ${targetFromCanvasUrl(canvasUrl) ? "open" : `closed (open it with /gentle:design)`}`,
			...(relay ? [`  open in your browser: ${urls.join("  ")}`, `  sessions: ${relay.sessionCount()}`] : []),
			...(relay
				? [
						"  Plain HTTP: the password travels unencrypted. Use it on a LAN/VPN, restrict it with allow, or put an HTTPS proxy in front.",
						`  The port must be open in the firewall (e.g. sudo ufw allow ${config.port}/tcp) and in the provider's security group/NAT.`,
					]
				: []),
		].join("\n");
	}

	/** Port/bind changes reopen the port; credentials and the allow list apply in place. */
	async function save(config: RemoteConfig, reopen: boolean): Promise<void> {
		saveConfig(await configPath(), config);
		if (!relay) return;
		if (reopen) await startFromConfig(config);
		else relay.update({ username: config.username, passwordHash: config.passwordHash, allow: config.allow, sessionHours: config.sessionHours });
	}

	async function run(args: string, ctx: ExtensionContext): Promise<{ message: string; level: "info" | "warning" | "error" }> {
		const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
		const value = rest.join(" ");
		const path = await configPath();
		const config = loadConfig(path);
		switch (sub) {
			case "status":
				return { message: status(config), level: "info" };
			case "help":
				return { message: usage(), level: "info" };
			case "on": {
				const missing = missingCredentials(config);
				if (missing) return { message: missing, level: "error" };
				await startFromConfig(config);
				config.enabled = true;
				saveConfig(path, config);
				return { message: status(config), level: "info" };
			}
			case "off":
				await stopRelay();
				config.enabled = false;
				saveConfig(path, config);
				return { message: status(config), level: "info" };
			case "port":
				config.port = parsePort(value);
				await save(config, true);
				return { message: `Port set to ${config.port}.${relay ? " The relay restarted; browsers sign in again." : ""}`, level: "info" };
			case "bind":
				config.bind = parseBind(value);
				await save(config, true);
				return { message: `Listen address set to ${config.bind}.`, level: "info" };
			case "user":
				if (!USERNAME.test(value)) return { message: "Username must be 1-64 characters: letters, digits, . _ @ -", level: "error" };
				config.username = value;
				await save(config, false);
				return { message: `Username set to ${value}.${relay ? " Every browser was signed out." : ""}`, level: "info" };
			case "password": {
				if (value) return { message: `Do not type the password on the command line; run /${COMMAND_NAME} password and enter it in the prompt.`, level: "error" };
				if (!ctx.hasUI) return { message: "Setting the password needs the interactive prompt.", level: "error" };
				const entered = await ctx.ui.input(`New remote password (at least ${MIN_PASSWORD_LENGTH} characters)`, "");
				if (!entered) return { message: "Password unchanged.", level: "warning" };
				config.passwordHash = await hashPassword(entered);
				await save(config, false);
				return { message: `Password saved as a hash.${relay ? " Every browser was signed out." : ""}`, level: "info" };
			}
			case "allow": {
				if (value === "clear") config.allow = [];
				else if (rest[0] === "remove") config.allow = config.allow.filter((entry) => entry !== rest[1]);
				else if (!config.allow.includes(parseAllowEntry(value))) config.allow.push(value);
				await save(config, false);
				return { message: `Allowed: ${config.allow.length > 0 ? config.allow.join(", ") : "any IP"}`, level: "info" };
			}
			case "logout-all":
				relay?.endSessions();
				return { message: "Every browser was signed out.", level: "info" };
			default:
				return { message: `Unknown subcommand "${sub}".\n${usage()}`, level: "error" };
		}
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Reach the gentle-design canvas remotely through <ip/host>:<port>, behind a username and password",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim())).map((s) => ({ value: s.value, label: s.label, description: s.description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			attachDesign(ctx);
			try {
				const { message, level } = await run(args, ctx);
				ctx.ui.notify(message, level);
			} catch (error) {
				if (error instanceof ConfigError || error instanceof PasswordError) return ctx.ui.notify(error.message, "error");
				ctx.ui.notify(`/${COMMAND_NAME} failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		attachDesign(ctx);
		try {
			const config = loadConfig(await configPath());
			if (!config.enabled || relay || missingCredentials(config)) return;
			await startFromConfig(config);
			ctx.ui?.notify?.(status(config), "info");
		} catch (error) {
			ctx.ui?.notify?.(`/${COMMAND_NAME}: ${(error as Error).message}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await stopRelay();
		detachDesign();
	});
}
