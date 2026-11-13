# gentle-remote

Gentle Shell extension: `/gentle:remote` opens a user-configured port that relays to the loopback gentle-design canvas,
behind a username/password login. Reference source: Gentle Shell commit 116821b (`.ref/gentle-shell`, not committed).

## Specs

- S1. "poder configurar con algun comando como /gentle:remote y dentro poder configurar por ejemplo el puerto donde se escucha"
- S2. "la extensión debe ser agnóstica" ("ya sea un homelab, un vps, un servidor rentado como aws")
- S3. "permitir que se abra un puerto (configurado por el usuario), ejemplo 30000 y que por debajo se lea, para no tener que obligar a los usuarios a usar, puede por ssh entrar y poder configurar pero entrar como por <ip/host>:30000"
- S4. "la idea es que todo se haga desde la propia extensión"
- S5. "agregar una capa, configurada en el mismo :remote agregar un tema de usuario y contraseña que se pida cuando se ingrese por primera vez"

Decisions agreed in conversation (not user quotes):
- D1. The canvas stays on 127.0.0.1 and its random port; the extension runs a relay on the configured bind/port.
- D2. Password stored as a scrypt hash, never plain text; `on` refuses without username and password.
- D3. After login an HttpOnly session cookie; failed logins rate-limited per IP; password change ends every session.
- D4. Optional `allow` list of IPs/CIDRs; the relay closes when the Pi session ends.
- D5. Limits outside the extension: firewall/security group/NAT, plain HTTP without a TLS proxy, Compare framing only the browser's localhost; the extension cannot start the canvas (the design service seam has no open()).

## Tasks

- T1 [S1,S5,D2] Package scaffold, config store, scrypt password — inline — commit: pending
- T2 [S3,S5,D3,D4] Relay HTTP server: login, sessions, rate limit, allow list, proxy with Host/Origin/CSP rewrite, SSE — inline — commit: pending
- T3 [S1,S4,D4] Extension: `/gentle:remote` command, canvas discovery via design service channel, lifecycle — inline — commit: pending
- T4 [S2,D5] README: install, usage, firewall/provider notes, security — inline — commit: pending
- T5 [all] Independent verify (security high-risk) — gentle-ai-verify — evidence: pending

## Log

- L1. User request: "Quiero hacer una extensión para gentle-shell, en esta extensión lo que busco es poder configurar para que se pueda ver gentle-design para aquellos que usan de manera remote (ya sea un homelab, un vps, un servidor rentado como aws, es decir, la extensión debe ser agnóstica), a idea es poder configurar con algun comando como /gentle:remote y dentro poder configurar por ejemplo el puerto donde se escucha y poder hacer que el usuario pueda conectarsde externamente para poder visualizar el apartado gentle-design"
- L2. "que problemas hay para la parte de tunelizar el puerto? la idea es que todo se haga desde la propia extensión"
- L3. "podemos, en vez de exponer y cambiar el puerto, permitir que se abra un puerto (configurado por el usuario), ejemplo 30000 y que por debajo se lea, para no tener que obligar a los usuarios a usar, puede por ssh entrar y poder configurar pero entrar como por <ip/host>:30000"
- L4. "lo que si, podemos agregar una capa, configurada en el mismo :remote agregar un tema de usuario y contraseña que se pida cuando se ingrese por primera vez"
- L5. Repo: https://github.com/AncientGear/gs-remote-design (commits, PRs and push configured).
- L6. Exploration: design service channel `gentle:desktop:design-service` exposes url()/observe() but no open(); canvas checks Host (421), Origin on POST (403), artboard CSP frame-ancestors/default-src name loopback; artboard subresources (files/*, system.html, assets/inspector.js) load from an opaque origin.
