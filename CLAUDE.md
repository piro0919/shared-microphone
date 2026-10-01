# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**shared-microphone** opens the microphone once and shares its audio frames with
every consumer that needs them. Its differentiator: consumers attach and detach
freely while the device stays open, so switching between them never costs the few
hundred milliseconds a reopen takes — a gap that turns wake word detection into a
miss rather than a delay.

- **npm package:** shared-microphone
- **Demo site:** <https://shared-microphone.kkweb.io>
- **Repository name is `shared-microphone`; the local directory is `mic-bus`.**
  npm rejected `mic-bus` as too similar to the existing `micbus`.

## Tech Stack

- TypeScript 5, no runtime dependencies
- Next.js 16 (App Router) — demo site only
- Biome (linter/formatter)
- tsup (library build, ESM + CJS)
- Vitest — tests
- Vercel (deployment)

## Project Structure

```text
src/
├── index.ts       # npm package entry point; exports the shared `micBus`
├── mic-bus.ts     # the implementation
└── app/           # Next.js App Router (demo site)
tests/             # Vitest
assets/            # Sora subset drawn into the Open Graph card
```

## Commands

```bash
pnpm dev         # demo site
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm build:lib   # tsup -> dist
pnpm build       # next build (demo site)
```

## Things this package deliberately gets right

Each came from real hardware. Do not "simplify" them away without a device to test on.

- **The output sink is silenced** with `setSinkId({ type: "none" })`. While Bluetooth
  is connected the AudioContext routes output to the headset, and some Android
  devices cannot establish full-duplex audio alongside microphone input; the render
  thread stalls and no frames arrive at all. iOS Safari has no `setSinkId`, so it is
  called only where it exists.
- **A context that starts suspended is resumed.** On Android Chrome the context
  starts suspended when a `getUserMedia` await comes first.
- **Only "something else is using it" failures are retried** — `AbortError`,
  `InvalidStateError`, `NotReadableError`, `TrackStartError`. Missing permission and
  missing hardware give the same answer however many times you ask.
- **A failure during wiring releases the microphone it acquired.** Otherwise an open
  device nobody receives from is stranded.
- **Concurrent opens collapse into one.** Letting them through opens a second device.
- **A fallback records the default device**, not the requested one. Otherwise a
  later `open(sameId)` sees the requested id and never tries it again.
- **`close()` is the override; `acquire()`/release is the shared path.** `close()`
  drops every reference and cancels an open in flight (a generation counter checked
  after each await). Without that cancel, the open finishes after the close and
  leaves the device on.
- **A track's `ended` closes the bus** and emits `device-ended`.

## Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, then push a `vX.Y.Z`
tag. `.github/workflows/publish.yml` publishes to npm with provenance and fails if
the tag and the version disagree.

## Notes

- `ScriptProcessorNode` is deprecated but is the only path confirmed to work
  everywhere including iOS Safari. An `AudioWorklet` path is under consideration.
- The demo site imports from `../index`, i.e. the source, not `dist`.
