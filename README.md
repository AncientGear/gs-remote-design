# gs-remote-design

A [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) extension for viewing the **gentle-design** canvas
from another machine when Gentle Shell runs remotely (homelab, VPS, AWS or any other server).

You choose a port, for example `30000`, and open `http://<ip-or-host>:30000/` in your browser. The first visit asks for a
username and password. No SSH tunnel, VPN client or third-party service is required.

## How it works

```
browser ──► <ip>:30000  (gentle-remote relay: login, session cookie, allow list)
                 │
                 ▼
          127.0.0.1:<random port>/<token>/  (gentle-design canvas, unchanged)
```

- The canvas keeps listening only on `127.0.0.1`, on its own random port, exactly as Gentle Shell ships it.
- The extension finds the canvas through gentle-design's design service (`gentle:desktop:design-service`) and follows it
  when it is reopened on a new port or token.
- Signed-in requests are forwarded with the `Host` and `Origin` the canvas expects. The canvas `Content-Security-Policy`
  is rewritten from the loopback origin to the address your browser used, so artboards still render inside the canvas.
- The live-reload stream is relayed without buffering.

## Install

```bash
pi install git:github.com/AncientGear/gs-remote-design
# or, from a local clone:
pi install ./gs-remote-design
```

Requires Node `^22.19.0 || >=23.6.0` and Gentle Shell with gentle-design.

## Usage

```text
/gentle:remote                    status: on/off, URL, canvas open/closed, sessions
/gentle:remote user <name>        username asked on the first visit
/gentle:remote password           set the password in a prompt (stored as a scrypt hash)
/gentle:remote port 30000         port to listen on (1024-65535, default 30000)
/gentle:remote bind 0.0.0.0       address to listen on: 0.0.0.0, ::, or one IP (LAN, Tailscale, WireGuard)
/gentle:remote allow 192.168.1.0/24   only accept these IPs/CIDRs (repeat to add)
/gentle:remote allow remove <entry> | allow clear
/gentle:remote on | off           open or close the port
/gentle:remote logout-all         sign every browser out
/gentle:remote help
```

Typical first setup:

```text
/gentle:remote user saul
/gentle:remote password
/gentle:remote port 30000
/gentle:remote on
/gentle:design                    open a design; then browse to http://<server-ip>:30000/
```

- `on` refuses to open the port until a username and a password are set.
- The password is never accepted on the command line, only in the prompt, so it does not end up in the command
  history. The prompt displays what you type, so make sure nobody can see your screen.
- Settings are stored in `<agent dir>/gentle-remote.json` with mode `0600`. When `on`, the relay starts again with the
  next Gentle Shell session and closes when the session ends.
- Changing the username or password signs every browser out. A port or bind change reopens the port.

## Security

Comments, "Implement this" and other canvas actions send prompts to the agent, and the agent runs commands on your
server. **Anyone who signs in can direct the agent.** Choose the password accordingly.

- Sessions use a random `HttpOnly`, `SameSite=Lax` cookie (12 hours). The cookie is `Secure` behind an HTTPS proxy
  that sends `X-Forwarded-Proto: https`.
- After 5 failed logins, an IP is locked out for 15 minutes.
- POSTs from another origin are rejected, both for the login form and for canvas actions.
- Artboard files (`files/*`, `system.html`, `assets/inspector.js`) run in a sandboxed opaque origin that browsers do
  not send cookies from. Those read-only paths are served without the cookie and are guarded only by the canvas'
  random token. Everything else requires a session.
- **Plain HTTP:** without TLS, the password and the cookie travel unencrypted. Use it on a LAN or VPN, restrict it with
  `allow`, or put an HTTPS reverse proxy in front (Caddy: `reverse_proxy 127.0.0.1:30000`, with
  `/gentle:remote bind 127.0.0.1`).

## What the extension cannot do for you

- **Firewall:** open the port in the OS (`sudo ufw allow 30000/tcp`) and in your provider (AWS security group, VPS
  firewall).
- **NAT / CGNAT:** a homelab behind a router needs port forwarding, and a CGNAT connection cannot be reached from
  outside at all.
- **Opening the canvas:** the design service lets an extension observe the canvas but not open it. Open it with
  `/gentle:design` or the agent. On a server without a display, ignore the "browser could not be opened" notice.
- **Compare:** the canvas only frames previews on the browser's `localhost`, so it cannot show an app that runs on the
  server.

## Development

```bash
npm test     # node --experimental-strip-types --test tests/*.test.ts
```
