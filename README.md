# ProxyDesk

A Windows desktop productivity application containing **10 independent Chromium browser workspaces**, each with its own cookies, cache, local/session storage, navigation state, and — genuinely, at the network level — its own proxy.

> The product name "ProxyDesk" and app id `com.proxydesk.desktop` are placeholders. Both are centralized in `package.json` / `electron-builder.yml` and can be renamed without touching source code.

## Features

- 10 browser workspaces by default (configurable 1–10), each a fully isolated Chromium session — separate cookies, localStorage, sessionStorage, HTTP cache, and (per browser) navigation history.
- Genuine per-browser proxy routing: each workspace's traffic is routed through its own proxy via a dedicated Electron `Session`, not a single global proxy setting. See [Architecture](#architecture) for why this matters and how it's implemented.
- HTTP, HTTPS, SOCKS4 and SOCKS5 proxy support, including authenticated proxies.
- A modular proxy-provider system (`ProxyProvider` interface) with a public-proxy provider, an imported-proxy provider, and a generic configuration-driven custom/API provider — add more without touching the rest of the app.
- Manual proxy import: single proxies, authenticated proxies, SOCKS URLs, `host:port`, `host:port:user:pass`, or a bulk `.txt` file, with a valid/invalid summary and no crash on malformed lines.
- Asynchronous, timeout-bounded proxy validation that makes a real HTTP request through each proxy (not just a TCP connect check) and never blocks the UI.
- One-click "Reload Proxies": fetch → dedupe → filter by country → validate → score → assign a unique proxy per browser (or leave unassigned rather than silently reusing an IP, unless you opt in to reuse).
- Per-browser "Replace Proxy" and a global "Replace Failed" for when a proxy dies mid-session.
- A country picker (ISO 3166-1 alpha-2) that filters candidate proxies, and honest "Unverified" labeling when a source doesn't provide trustworthy country metadata — proxies are never mislabeled with a guessed country.
- Proxy Manager table (search/filter/sort, per-row Test, export as TXT/CSV/JSON) and a Browser Assignment overview (per-browser proxy, country, latency, detected IP, Check IP / Check All IPs).
- A real Settings screen: Browser, Proxy, Proxy Providers, Performance, and Application sections.
- Session persistence toggle (cookies/localStorage/login state per browser, backed by per-browser partitioned Electron sessions on disk).
- Crash recovery (up to 3 automatic restart attempts per browser, the other 9 keep running) and network-loss tolerance (no session teardown, previously-known proxies keep working).
- Structured logs (`application.log`, `proxy.log`, `browser.log`) that never contain passwords or auth secrets, plus a Diagnostics screen with a Copy Diagnostics button.
- Dark / Light / System themes (default dark), keyboard shortcuts, responsive 1×10 / 2×5 / 5×2 grid layouts.
- Secure-by-default Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a whitelisted typed IPC surface, and a strict `Content-Security-Policy`.

## Architecture

```
                  ┌──────────────────┐
                  │   Proxy Manager  │
                  └────────┬─────────┘
                           │
          ┌────────────────┼────────────────┐
          ↓                ↓                ↓
   Public Providers   Imported List    Custom / API Provider
          │                │                │
          └────────────────┼────────────────┘
                           ↓
                    Proxy Validator  (real HTTP request through each proxy)
                           ↓
                    Proxy Scorer     (latency + reliability + country confidence)
                           ↓
                    Proxy Assigner   (unique-IP-preferring, country-filtered)
                           ↓
        ┌──────────┬──────────┬──────────┬─────·····─┐
        ↓          ↓          ↓          ↓            ↓
     Browser 1  Browser 2  Browser 3  Browser 4 ... Browser 10
```

### Per-browser proxy isolation (the part that's easy to fake and isn't, here)

A single `session.defaultSession.setProxy(...)` call is app-wide — it cannot give ten browsers ten different proxies. Genuine isolation needs each workspace to own its own Electron `Session`:

- Each browser gets `session.fromPartition('persist:browser-N')` (or a non-persistent partition when "Persist sessions" is off in Settings). Electron partitions cookies, localStorage, sessionStorage and HTTP cache per session automatically — this is what makes the 10 workspaces independent, not just visually separate.
- Each browser's session gets its own `ses.setProxy({ proxyRules: '<protocol>://host:port' })` call, so **that browser's traffic alone** goes through its assigned proxy. See `src/main/BrowserManager.ts` (`assignProxy`) for the exact call.
- Each browser's web content renders in its own `BrowserView`, attached to one shell `BrowserWindow` and positioned with `setBounds` to form the grid — this is what makes 10 independent Chromium renderer processes possible under one native window.
- Proxy-auth challenges (`407 Proxy Authentication Required`) are handled via a single `app.on('login', ...)` handler (this is the only place Electron surfaces proxy auth — it is not per-`Session` in the Electron version this project targets), which looks up the specific browser that triggered the challenge by its `WebContents` id before releasing that browser's own proxy credentials. Browser 1's proxy password is never available to Browser 2's proxy prompt.

This design was chosen after checking what Electron 31.x's `Session`/`WebContents`/`app` APIs actually expose (see the comment block at the top of `src/main/BrowserManager.ts`) rather than assuming an API shape — an earlier draft of this file assumed `Session#login` and `WebContents#navigationHistory.canGoBack()` existed; they don't in this Electron version, and the code here uses the APIs that do.

### Why JSON files instead of SQLite

Persisted state (settings, known proxies, browser→proxy assignments, provider health) is small, infrequently written, and document-shaped. `StorageManager` (`src/main/StorageManager.ts`) does atomic (`write-temp-then-rename`) JSON writes to Electron's `userData` directory. This avoids a native-module (SQLite) build dependency that would complicate the GitHub Actions matrix for no real benefit at this data size — and it keeps `npm install` fast and prebuilt-binary-free. If you outgrow it, `StorageManager`'s `read`/`write` interface is the single seam to swap in a real database.

### Secrets

Proxy passwords are encrypted at rest with Electron's `safeStorage` API (backed by Windows DPAPI / Credential Manager on Windows, Keychain on macOS) — see `StorageManager.encryptSecret` / `decryptSecret`. Logs redact anything that looks like a password, API key, or `user:pass@` URL segment before it's ever written to disk (`src/main/Logger.ts`).

### IPC boundary

`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`. The renderer has **no** direct access to Node or unrestricted Electron APIs — only `window.app.*`, a narrow typed surface defined once in `src/shared/types/ipc.ts` and implemented identically in `src/preload/preload.ts` and `src/main/ipc/registerIpc.ts`. No IPC channel name is ever constructed from renderer input.

## Requirements

- Node.js 20+
- npm 10+
- Windows 10/11 for running the packaged app (development can happen on macOS/Linux too, but see [Known Limitations](#known-limitations) re: packaging a Windows installer locally on non-Windows hosts)

## Local development

```bash
npm install
npm run dev
```

This starts the Vite dev server for the renderer and launches Electron pointed at it, with hot reload for the renderer and DevTools open by default. `npm run dev` runs `vite` and a small launcher script (`scripts/wait-and-launch.js`) concurrently; the launcher waits for Vite, compiles the main/preload TypeScript, and starts Electron.

Other useful scripts:

```bash
npm run typecheck   # tsc --noEmit for both main/preload and renderer
npm run lint         # eslint across src/ and tests/
npm test             # vitest run
npm run test:watch   # vitest in watch mode
```

## Production build

```bash
npm run build        # builds the renderer (Vite) and compiles main/preload (tsc)
npm run package:win  # builds, then packages a Windows NSIS installer
```

`npm run package:win` runs `electron-builder --config electron-builder.yml --win nsis`, producing `release/MultiBrowserProxySetup.exe`.

## GitHub Actions

`.github/workflows/build-windows.yml` runs on `windows-latest` and, on every push/PR to `main` and on version tags:

1. Checks out the repo, installs Node 20, `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm test`
5. `npm run build`
6. `npm run package:win`
7. Uploads `release/MultiBrowserProxySetup.exe` as a workflow artifact (**Actions tab → the workflow run → Artifacts → `MultiBrowserProxySetup-windows`**)
8. On a `v*` tag push, also creates a GitHub Release with the `.exe` attached

To cut a release: `git tag v0.1.0 && git push origin v0.1.0`.

## Proxy providers

Providers implement one interface:

```ts
interface ProxyProvider {
  readonly name: string;
  readonly kind: 'public' | 'imported' | 'custom';
  fetchProxies(options: { countryCode?: string; signal?: AbortSignal }): Promise<ProxyRecord[]>;
}
```

Shipped providers (`src/proxy/providers/`):

- **PublicProxyProvider** — fetches from ProxyScrape's free, publicly documented, no-auth API (a plaintext proxy list endpoint designed for exactly this kind of automated retrieval — no CAPTCHA or access-control bypass involved). Disabled by default; enabling it in the toolbar or Settings shows a one-time warning about the risks of public proxies. This provider is honest about not being able to verify per-proxy country from the free endpoint, so it returns nothing rather than guessing when a country filter is active.
- **ImportedProxyProvider** — surfaces whatever you've imported via the Import Proxies dialog through the same interface, so `ProxyManager` never special-cases it.
- **CustomProxyProvider** — a generic, configuration-driven adapter for your own private/paid proxy API (name, URL, method, headers, a country query param, and a dot-path to the array of proxies in the JSON response). Configure it in **Settings → Proxy Providers**. No API key is ever hard-coded — see `.env.example` and the header-based configuration in Settings.

If a provider fails (network error, rate limit, HTML change, timeout), `ProxyManager.reload()` records the error against that provider's health entry and continues with whatever the other providers returned — a dead public proxy site never blocks Reload Proxies. Provider health is visible in the Proxy Manager screen.

## Importing proxies

Paste into the Import Proxies dialog (one per line) or import a `.txt` file:

```
http://1.2.3.4:8080
http://username:password@1.2.3.4:8080
socks5://9.10.11.12:1080
127.0.0.1:8080
127.0.0.1:8080:username:password
```

Malformed lines are collected and reported (`Imported: 50 / Valid: 47 / Invalid: 3`) rather than aborting the whole import.

## Security & privacy notes

- A proxy does not guarantee anonymity or security. Traffic may be observable by the proxy operator.
- Free public proxies may be unreliable, slow, or malicious. Avoid entering sensitive credentials through untrusted proxies.
- You can disable public providers entirely (Settings → Proxy Providers, or the toolbar checkbox) and rely only on imported or custom/private proxies.
- Proxy passwords are encrypted at rest via OS-backed `safeStorage`; logs redact secrets; IPC is a whitelisted, typed surface with no raw Node/Electron access from the renderer.

## Testing

`npm test` runs the Vitest suite in `tests/`, covering:

- `ProxyParser`: `http://host:port`, authenticated (`user:pass@`), `socks5://host:port`, `host:port`, `host:port:user:pass`, and garbage input (never throws via `tryParseLine`, throws a descriptive error via `parseLine`)
- Bulk `.txt` parsing that tolerates comments, blank lines, and malformed lines without aborting
- Duplicate detection (`dedupeProxies`) — same protocol+host+port merges and preserves both sources
- Country filtering (`filterByCountry`)
- Proxy assignment: 10 proxies → 10 browsers (all unique), 6 proxies → 10 browsers (6 assigned, 4 left unassigned), 0 proxies → all unassigned, reuse-vs-no-reuse behavior, dead-proxy exclusion, minimal-disruption reassignment (a browser keeps its current healthy proxy across a reload), and stable browser-id ordering
- Proxy scoring (`scoreProxy`) — dead proxies score 0; low-latency/high-reliability outranks high-latency/low-reliability

## Troubleshooting

- **"No proxies available" after Reload Proxies** — public providers are off by default (by design; see the security note above). Enable them in Settings, or import your own proxies.
- **A browser shows "Proxy failed"** — click **Change Proxy** on that panel, or **Replace Failed** in the toolbar to sweep every browser with no working proxy.
- **`npm run package:win` fails locally on macOS/Linux** — see [Known Limitations](#known-limitations); use the GitHub Actions workflow, which runs on `windows-latest` and packages natively.
- **High memory usage with 10 browsers running** — lower "Number of browsers" in Settings, enable "Suspend inactive browsers" under Performance, or reduce "Maximum concurrent page loads".

## Known limitations

Being direct about what this project can't fully guarantee:

- **Public proxy reliability is inherently unreliable.** Free proxy sources change, disappear, rate-limit, or serve dead/slow IPs. ProxyDesk validates before assigning and reports honest failure states, but it cannot make a free public proxy good.
- **Country metadata is best-effort.** The bundled public provider does not label individual proxies with a verified country from its free endpoint; ProxyDesk reports those as "Unverified" rather than guessing. Only providers that supply real per-proxy country metadata (a custom/API provider you configure, or proxies you import with metadata you trust) produce a `countryVerified: true` label.
- **A proxy is not anonymity.** See the Security & privacy notes above — this is a proxy manager, not a VPN or anonymization tool, and makes no such claim in the UI.
- **Packaging a Windows `.exe` on macOS/Linux locally requires Wine** (for the NSIS resource/icon-signing step electron-builder runs). This repository's own verification built successfully through packaging and asset validation on Linux and stopped only at that Wine-dependent step — the GitHub Actions workflow runs on `windows-latest`, where this step is native and unaffected. If you need to package locally on non-Windows, install Wine, or build in a Windows VM/CI runner.
- **Code signing is not configured.** The NSIS installer is unsigned; Windows SmartScreen may warn on first run. Add a code-signing certificate and `electron-builder` signing config if you need a signed installer.
- **Auto-update is not wired up.** The project is structured so `electron-updater` can be added later (electron-builder + NSIS already support it) but no update server or `autoUpdater` calls are implemented in this version.
- **BrowserView is used, not the newer WebContentsView.** Electron 31.x still fully supports `BrowserView`; `WebContentsView` is the documented eventual replacement. Swapping later only changes how a view attaches to the window, not the per-session-proxy design.
- **10 Chromium sessions are inherently RAM/CPU-heavy.** This is a Chromium/OS-level cost, not something any Electron app can eliminate; Settings exposes levers (browser count, concurrent page loads, suspend-inactive) to trade functionality for resource usage on constrained machines.


## SEO Tracker, Enhanced Keep Alive and Timed Rotation

The SEO Tracker runs a user-triggered Google search in each selected browser, scans up to the configured number of result pages for a target hostname, clicks the matching organic result in the Google results page itself, waits for the target page to load, and then starts Keep Alive for that browser. Google challenge pages are reported as blocked rather than treated as a result.

Enhanced Keep Alive performs randomized scrolling and can optionally hop to visible same-site content links. Page hopping is configurable from 0 to 1000 and filters account, login, logout, cart, checkout, payment, download, admin and destructive paths.

Proxy rotation can be enabled with a custom interval in seconds (minimum 5 seconds). Timed rotation uses the existing proxy pool rather than re-running the complete proxy validation pipeline on every tick. The toolbar also provides a **Rotate Now** action.
