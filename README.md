# FocusGuard

FocusGuard is a Chrome extension (Manifest V3) that combines the self-control features of StayFocusd and the convenience features of BlockSite. It blocks sites, sets daily time budgets, hides parts of pages (YouTube Shorts, comments, feeds), runs Pomodoro focus sessions, and has a Hard Lock that cannot be cancelled. Usage insights stay on your device.

It implements v1 of the PRD *FocusGuard — User Persona & PRD*: all three milestones (M1 core blocking, M2 commitment and focus, M3 insights and polish). It also adds **parental controls**, which the PRD had left for later (see below).

## Install (unpacked)

```bash
npm install
```

```bash
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `dist/` folder. The onboarding page opens on first install.

Requirements: Node 22.18+ (the tests run TypeScript directly), Chrome 120+ or another Chromium browser (Edge, Brave).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Bundle `src/` into `dist/` with esbuild |
| `npm run watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` over sources and tests |
| `npm test` | Unit tests (`node --test`, 92 tests) |
| `npm run e2e` | Build, then load `dist/` into a real headless Chrome with a throwaway profile: core (13), parental controls (7) and the image classifier (1). Uses the installed Chrome; set `CHROME_PATH` to use another. The parental suite needs `openssl` for a throwaway HTTPS certificate. |
| `npm run zip` | Build and write `focusguard-<version>.zip` for the Chrome Web Store |
| `npm run icons` | Redraw the PNG icons in `src/icons/` |
| `npm run check` | typecheck + unit tests + build |

## How it works

```
UI pages (popup, options, onboarding, block page)
        │  runtime messages: getState / applyChange / …
        ▼
Service worker  ── owns all state (chrome.storage is the source of truth)
   ├─ rule engine: active rules from schedules, focus phase, Hard Locks, pause, budgets
   ├─ gate: classifies every change as tightening or loosening, enforces Hard Lock and commitment level
   ├─ tracker: active-tab time (focused window, not idle) → per-domain stats and budgets
   └─ enforcement
        ├─ declarativeNetRequest dynamic rules → block page / redirect before the page loads
        ├─ tab sweep + tabs.onUpdated → already-open tabs, SPA navigations, back/forward cache
        └─ hideIndex in storage → content script injects CSS at document_start
```

- **Recompute** runs on every trigger (rule edit, alarm, focus phase change, lock start or end, budget exhausted, startup). It is idempotent and only rewrites DNR rules or the hide index when they change.
- **Priorities.** Every rule gets `band × 100000 + specificity × 10 + rank`. The band is 1 for rules forced on by a Hard Lock. The rank is block 4, redirect 3, hide 2, allow 0. So a more specific allow rule beats a broader block (FR-1.5), the strictest action wins at equal specificity (FR-1.6), and nothing outside a Hard Lock can punch a hole in it. `decideUrl()` in JavaScript and the compiled DNR rules use the same numbers, and a unit test checks that they agree.
- **Block page privacy.** The block page URL carries only `?r=<rule id>&t=<target index>`, never the visited URL. Blocked attempts are counted per target domain from that pair.
- **Timers** use `chrome.alarms` (a 1-minute tick plus an exact alarm for the next schedule edge, phase end, lock end or reset) and persisted state, never `setTimeout` alone.

### Source map

| Path | Contents |
| --- | --- |
| `src/shared/` | Pure, unit-tested logic: data model (`types.ts`), URL matching (`url.ts`), schedules and budget periods (`schedule.ts`), focus phases (`focus.ts`), rule evaluation (`rules.ts`), DNR compiler (`dnr.ts`), change classification (`changes.ts`), message contract (`messages.ts`), insights and CSV (`insights.ts`), categories (`categories.ts`), PBKDF2 (`crypto.ts`) |
| `src/background/` | Service worker: state and locking, engine, tracker, apply/gate, message handlers |
| `src/content/` | `hide.ts` (always-on, 4.7 KB built), `picker.ts` (element picker, injected on demand), `selector.ts` |
| `src/presets/presets.json` | Versioned element-hiding presets (YouTube, Reddit, X, Instagram) |
| `src/options/` | Options shell and sections: Rules, Element hiding, Focus mode, Hard Lock, Block page, Insights, Settings |
| `src/popup/`, `src/blocked/`, `src/onboarding/` | Toolbar popup, block page, first-run page |
| `src/ui/` | DOM helper (no `innerHTML`), gate dialogs, shared CSS (light and dark) |
| `src/locales/*.json` | UI strings, merged into `_locales/en/messages.json` at build |

## Parental controls

Settings → **Parental controls** (or the fourth onboarding card) turns on a filter for a child's browser, protected by a guardian PIN. The PIN is separate from your own commitment level. Every parental setting needs it, and Pause and Hard Lock do not touch the filter. Parental blocks run in the highest priority band, so the user's own allow rules cannot open a filtered site.

| Layer | How it works |
| --- | --- |
| Known adult sites | A curated list of 231 domains (`src/parental/known-sites.ts`), blocked with subdomains before the page loads (declarativeNetRequest). |
| Page detection | A content script, registered only while parental mode is on, checks adult-content labels (RTA, `rating`, `og:restrictions:age`) and scores a weighted multilingual word list over the URL, title, meta, headings, link text and a capped text sample. The page stays hidden until the check finishes, for at most 1.5 s. |
| Adaptive learning | With "block the whole site", a detected page teaches FocusGuard the site, and every later visit is blocked before it loads. Guardians see learned sites and can forget them. |
| Image scanning | NSFWJS (MobileNetV2, 2.7 MB) runs on TensorFlow.js in an offscreen document: about 24 ms per image after a 4 s first load. Explicit images are blurred, and a page with several is blocked. At High sensitivity, images stay blurred until cleared. |
| Social feeds | On Reddit, X, Instagram, Tumblr and TikTok, single posts are hidden (posts the site marks NSFW, or explicit post text) instead of blocking the whole site. |
| SafeSearch | Google, Bing and DuckDuckGo searches get their strict-filtering parameter, and YouTube requests get the `YouTube-Restrict: Strict` header (Restricted Mode). |

On the block page a guardian can allow a learned site with the PIN. Sensitivity (low, medium, high), extra blocked words and always-allowed sites are adjustable.

**Limits.** Anyone who can open `chrome://extensions` can remove an extension. For real enforcement, use Google Family Link or Chrome policies: `ExtensionInstallForcelist`, `IncognitoModeAvailability=1` and `DeveloperToolsAvailability=2`. Incognito is not filtered unless FocusGuard is allowed there; the settings page warns when it is not. On-device detection can miss content or flag a safe page. The social-site selectors and the explicit-image thresholds have not been checked on real signed-in feeds or real explicit images.

## Requirements coverage

| PRD item | Status |
| --- | --- |
| FR-1 rules and matching (domain, subdomains, prefix, exact URL, groups; block, redirect, hide, budget; schedules, focus condition, Hard Lock; allowlist; most-restrictive-wins) | Done |
| FR-2 time budgets (active tab + focused window + not idle, daily reset time, 2-minute warning, block on all tabs, badge) | Done |
| FR-3 Hard Lock (15 min–24 h, sites and rules, recurring days, cannot end or loosen, survives restart and reload, tighten allowed) | Done |
| FR-4 commitment levels (None, Password with PBKDF2, Challenge with about 300 typed characters and paste off, gate on loosening only) | Done |
| FR-5 element blocking (selectors, picker, presets, document_start, SPA, versioned preset file) | Done, except a remote preset update channel (see gaps) |
| FR-6 Focus Mode (25/5/15/4, focus list, notifications, popup and badge countdown, early-end rules) | Done |
| FR-7 block page and redirect (reason, time until unblock, custom text and image ≤ 2 MB, loop detection) | Done |
| FR-8 insights (per-day aggregates, categories with overrides, day/week views, time saved, CSV export, delete all) | Done |
| FR-9 onboarding (three templates, permissions explained, under 2 minutes) | Done |
| Non-functional: privacy, permissions, performance, reliability, security (strict CSP, http/https redirects), tamper honesty, accessibility (keyboard, labels, live regions, a timed-delay alternative to the Challenge), compatibility, localization | Done |

The end-to-end suite covers UC-1 to UC-7 and FR-2.1/FR-8.1 against a real Chrome. UC-8 (weekly insights) is covered by unit tests and a render check.

## Decisions made where the PRD left room

- **Open question 4: does Hard Lock freeze the commitment level? Yes.** During any Hard Lock you cannot lower the level, change the password or change loosening settings.
- **Open question 2: categories.** A built-in map of about 165 domains, which users can override per site.
- **Open questions 1 and 3 (pricing, sync)** do not affect v1. Everything is free and local.
- **Allow vs. most restrictive.** An allow rule wins only over rules that are less specific than it; at equal specificity the stricter rule wins. Allow rules also stop budget counting and hiding on their URLs.
- **Hard Lock beats allow rules.** An allow rule cannot open a locked site unless the lock itself includes that allow rule. A budget rule under a lock becomes a plain block.
- **The gate runs per change.** Each loosening save asks once. The accessible alternative to typing is a cooling-off delay, 5 minutes by default (1–60). The delay keeps running if the popup closes.
- **FR-6.4.** Under Password, ending a focus session early asks for the password. Under Challenge it is not possible, and neither is it during a Hard Lock.
- **"Widen schedule" in FR-4.3.** For a blocking rule, narrowing its schedule is what loosens; widening it tightens. Allow rules are the reverse. Schedules are compared minute by minute over the week.
- **"Time saved"** = unused budget plus 3 minutes per blocked visit. The 3 minutes is an assumption you can change in Settings.
- **Matching.** `www.` is treated as the bare host. Prefix targets also match subdomains (so `reddit.com/r/x` covers `old.reddit.com/r/x`), and matching ignores case.
- **Uninstall friction.** Disabling FocusGuard from inside the extension (Pause) goes through the gate. Removing it opens an accountability page you choose (`setUninstallURL`); it is off by default. The UI says plainly that no extension can stop being removed in `chrome://extensions`.

## Known gaps

- **Preset selectors.** The YouTube selectors were checked against the live site on 2026-11-08 (logged out). The Reddit, X and Instagram selectors are best-known values and have not been verified: the test browser refused Reddit, and X and Instagram need a login.
- **No remote preset updates (FR-5.4).** Presets are a versioned data file shipped with the extension, so a selector fix still needs a store update. A remote channel needs a hosting decision.
- **No success-metric telemetry.** The PRD's opt-in anonymous event counts need a backend, so they are not built.
- **English only.** All strings are in `_locales`, but only English exists.
- **Not tested on Edge or Brave**, and not tested on a signed-in browser profile.
- **Time tracking end to end.** Headless Chrome never reports a focused window, so the end-to-end test feeds the tracker the focus and idle events Chrome would send. Real focus changes have not been tested in an automated run.

## Privacy

FocusGuard stores only domains, durations and counts per day, plus your own rules. It never reads page text or form data, with one exception: while parental controls are on, page text and images are analysed on this device, and only the names of learned sites are kept. It never stores full URLs from your browsing; the open tracking segment lives in memory-only session storage and holds just the domain. It makes no network requests of its own and has no analytics. The image classifier re-downloads images already on the page, without cookies, to score them locally. Insights older than 120 days are deleted automatically, and Settings → Insights can delete them all at once.

## License

MIT. Copyright The FocusGuard Authors.
