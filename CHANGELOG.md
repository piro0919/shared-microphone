# Changelog

## Unreleased

### Added

- `acquire(deviceId?)` returns a release function and reference-counts the device:
  it opens on the first reference and closes when the last one is released, so one
  consumer finishing no longer closes the microphone for the others.
  `holderCount` reports how many are held. `close()` stays the forced close for
  everyone and now also drops every reference.
- `device-ended` warning. When the open device's track ends (unplugged, revoked)
  the bus closes and reports it, instead of looking open while no frame arrives.
- `engines.node` is back, as `>=18`. CI checks the packed package with
  `publint --strict` and `attw` (`pnpm check:package`), runs the tests on Node 22
  and 24, and checks the build loads on Node 18 and 20.

### Fixed

- **BREAKING:** after a requested device fails and the default one is opened
  instead, `deviceId` reads `null` (the device actually open) rather than the
  requested id. Before, a later `open(sameId)` saw the requested id, did nothing,
  and stayed on the default device for good.
- **BREAKING:** `close()` during an `open()` cancels it. The open rejects with an
  `AbortError` and releases the microphone it acquired. Before, the open finished
  after the close and left the microphone on. Code that calls `close()` while an
  `open()` is pending must now handle the rejection.
- **BREAKING:** an invalid `frameSize` throws a `RangeError` from `createMicBus`.
  It must be a power of two from 256 to 16384. Before, it failed on the first open.
- **BREAKING (types):** `MicBusWarning` has a new member, `device-ended`. An
  exhaustive `switch` over `warning.type` needs a case for it.

## 0.1.3

### Changed

- Repository layout now matches the other packages: tests live in `tests/`, biome
  runs on commit through lefthook, and `engines` is gone (it pinned nothing useful
  and made the host warn about automatic Node upgrades).

## 0.1.2

### Changed

- Ships both ESM and CJS builds with source maps, so `require()` works alongside
  `import`.

## 0.1.1

### Changed

- Everything is written in English: README, source comments and type documentation.
  The first release carried Japanese prose, which is unhelpful in a public package.

## 0.1.0

Initial release, published as `shared-microphone`. The name `mic-bus` was rejected
by npm as too similar to the existing `micbus`.

### Added

- `micBus` / `createMicBus` — open the microphone once and share its frames with
  every consumer. Handles the device quirks found in production: silencing the
  output sink so Bluetooth does not stall the render thread, resuming a context that
  starts suspended, retrying only the failures worth retrying, releasing an acquired
  microphone when wiring fails, and collapsing concurrent opens into one.
