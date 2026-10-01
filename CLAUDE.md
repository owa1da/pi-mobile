# CLAUDE.md

Pi (pi-mobile) is a minimal Expo / React Native app that manages "pi" coding-agent sessions on a
host over direct SSH. Nothing is installed on the host: pi runs unchanged in tmux and the app
reads forge procs files, pi session `.jsonl` files and tmux panes over SSH. Based on Paseo by
Mohamed Boudra (Apache-2.0); see LICENSE and NOTICE.

## Repository map

- `packages/app` — the Expo app (Expo 54, RN 0.81, expo-router 6, react-native-unistyles 3; `@/` = `packages/app/src`)
  - `src/app/` — routes: `index.tsx` (hosts), `h/[hostId]/index.tsx` (dashboard), `h/[hostId]/s/[sessionId].tsx` (session)
  - `src/ssh/`, `modules/pi-ssh/` — SSH client (native module + Node test double)
  - `src/host/` — host service: procs/session parsing, tmux commands
  - `src/components/` — design-system primitives (`ui/`), chat rendering (`message.tsx`, `tool-call-*`, `markdown/`), terminal (`terminal-emulator-webview.native.tsx`)
  - `src/styles/` — theme tokens + unistyles config; `src/appearance/` — theme/font application
- `packages/highlight` — syntax highlighter used by code blocks (build with `npm run build:highlight`)

## Docs

`docs/` holds the design-system conventions inherited from Paseo: design.md, unistyles.md,
coding-standards.md, forms.md, menus.md, hover.md, floating-panels.md, expo-router.md, i18n.md.
Read the relevant one before building UI.

## Commands

- `npm run build:highlight` — required before typecheck/bundle on a fresh checkout
- `cd packages/app && npm run typecheck` — tsgo
- `cd packages/app && npx vitest run --project unit` — unit tests (node env, `test-stubs/`)
- `cd packages/app && npx vitest run --project integration` — real tmux/sh/sshd tests, serial
- `cd packages/app && npm run build:terminal-webview` — regenerate the xterm webview HTML
- `npm run knip`, `npm run lint`, `npm run format`

## Rules

- Run typecheck and the relevant tests after every change; run single test files when iterating.
- Import platform gates (`isWeb`, `isNative`) from `@/constants/platform`; layout decisions use
  `useIsCompactFormFactor()` from `@/constants/layout`. Default is cross-platform.
- Never use raw DOM APIs without an `isWeb` guard. Hover never fires on native: use
  `isHovered || isNative || isCompact` for hover-revealed controls.
- Styles: `StyleSheet.create((theme) => …)` from react-native-unistyles; see docs/unistyles.md.
- User-facing strings go through i18n (`useTranslation()`, keys in `src/i18n/resources/en.ts`).
- Never modify files under the host's `~/.pi/agent/forge/procs` registry; the app only reads them.
