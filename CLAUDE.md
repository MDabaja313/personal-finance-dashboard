# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — run ESLint

No test framework is configured yet.

## Architecture

This repo is currently at the default `create-next-app` scaffold stage (Next.js 16.3.1, App Router, React 19.2.8) — there is no dashboard functionality, data layer, or state management implemented yet. What exists:

- **App Router** under `app/`, with `@/*` aliased to the repo root (`tsconfig.json`).
- **Tailwind CSS v4, CSS-first config** — there is no `tailwind.config.*` file. Theme tokens are declared directly in `app/globals.css` via `@theme inline`, and dark mode is handled with a `prefers-color-scheme` media query (not a class-based toggle).
- **Fonts** are loaded via `next/font/google` (Geist / Geist Mono) in `app/layout.tsx` and exposed as CSS variables that the Tailwind theme consumes.
- **ESLint** uses the flat config format (`eslint.config.mjs`), extending `eslint-config-next`'s core-web-vitals and typescript configs.

Since this Next.js version has breaking changes from what you may expect (see `AGENTS.md` above), consult `node_modules/next/dist/docs/` before introducing new framework-specific patterns (routing, data fetching, layouts, etc.).
