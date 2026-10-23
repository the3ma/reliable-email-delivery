# Delivery Console (web)

The local demo UI from [docs/CONSOLE.md](../docs/CONSOLE.md): dashboard, scenarios
(expected vs observed), deliveries with a state-timeline drawer, the local Mailbox and the
suppression list. It talks only to `console-api` under `/api/v1` and is never deployed.

This folder is its own npm package (own `package-lock.json`, not part of the root workspace).

```bash
npm ci
npm run dev:mock   # no backend: MSW serves realistic in-memory fixtures (http://localhost:5173)
npm run dev        # proxies /api to console-api (API_PROXY_TARGET, default http://localhost:3001)
npm test           # Vitest + Testing Library + MSW
npm run lint       # eslint (strictTypeChecked, --max-warnings 0) + prettier --check
npm run typecheck
npm run build      # tsc + vite build -> dist/
```

## Container

`docker build -t delivery-console-web .` builds the `serve` stage: nginx (unprivileged user,
port **8080**) with the SPA fallback, gzip, `/healthz`, security headers and `/api/` proxied to
`http://${API_UPSTREAM}` (default `console-api:3001`, resolved per request so the UI starts
while the API is down). `--target build` stops after compiling.

## Safety notes

- E-mail HTML is only ever rendered in `<iframe sandbox="" srcdoc>`; the srcdoc starts with a CSP
  (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) so remote images, fonts and
  tracking pixels never load. The page CSP (nginx) intersects with it.
- Addresses are masked everywhere except the Mailbox of fake `example.test` users; the feedback
  simulator accepts `@example.test` addresses only.
- Polling (2 s on the dashboard) doubles its delay after failures (cap 30 s) and pauses while the
  tab is hidden.
