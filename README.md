# shared-microphone

Opens the microphone once and shares its audio frames with everything that needs them.

When two or more things need the same audio — wake word detection and transcription,
say — having each of them call `getUserMedia` means the device is reopened every time
you switch between them. Reopening takes hundreds of milliseconds on some hardware,
and whatever is said during that window is lost entirely. Wake word matching falls
below its threshold when the start of an utterance is clipped, so this shows up as
the wake word simply not firing rather than as a delay.

- No runtime dependencies
- One device, however many consumers. The same request never opens a second one
- One listener throwing does not stop delivery to the others
- Works around the device quirks listed below, each found on real hardware

## Install

```bash
npm install shared-microphone
```

## Usage

```ts
import { micBus } from "shared-microphone";

// Start receiving. You can subscribe before the microphone is open.
const stopListening = micBus.subscribe((samples, sampleRate) => {
  // samples is single-channel Float32 in the -1..1 range
  recognizer.write(samples, sampleRate);
});

// Open the microphone. Pass null for the default device.
await micBus.open(selectedDeviceId);

// Stop receiving. The microphone stays open.
stopListening();

// Release the microphone — handing it to a call, or when the tab goes to the background.
micBus.close();
```

`subscribe` and `open` are independent. Starting or stopping a recording never
touches the device, so moving between wake word detection and transcription causes
no reopen.

### Several consumers

```ts
micBus.subscribe(wakeWordDetector.write);
micBus.subscribe(transcriber.write);
await micBus.open();
// Both receive the same frames from a single device.
```

### Sharing the device without closing it on each other

`close()` closes the device for everyone. When consumers come and go on their own,
have each take a reference with `acquire()` instead. The device opens on the first
reference and closes when the last one is released.

```ts
// In the wake word detector
const release = await micBus.acquire();
const unsubscribe = micBus.subscribe(wakeWordDetector.write);
// ...
unsubscribe();
release(); // The transcriber, if it still holds a reference, keeps receiving.
```

`acquire(deviceId)` switches the one device for every holder, as `open(deviceId)`
does. If opening fails the promise rejects and no reference is taken.
`micBus.holderCount` reports how many are held.

`close()` is the override: it closes the device now, drops every reference (their
release functions become no-ops), and cancels an `open()` or `acquire()` still in
progress, which then rejects with an `AbortError` and releases whatever device it
had acquired.

### Surfacing what went wrong

```ts
import { createMicBus } from "shared-microphone";

const bus = createMicBus({
  onWarning: (warning) => {
    if (warning.type === "device-fallback") {
      toast.warning("That microphone is unavailable. Using the default one.");
    }
  },
});
```

| `type` | Meaning |
| ---- | ---- |
| `device-fallback` | The requested device could not be opened, so the default one is in use. `deviceId` reads `null`, and opening the requested device again tries it again |
| `device-ended` | The open device stopped delivering audio, e.g. it was unplugged. The bus has closed; `open()` or `acquire()` reopens |
| `listener-failed` | A listener threw. Delivery to the others continued |
| `sink-not-silenced` | The output sink could not be silenced. It still works |

## Options

Pass them to `createMicBus(options)`. The exported `micBus` is `createMicBus()`.

| Option | Default | Meaning |
| ---- | ---- | ---- |
| `frameSize` | `4096` | Samples per frame. Roughly every 85 ms at 48 kHz. A power of two from 256 to 16384; anything else throws a `RangeError` from `createMicBus` |
| `getUserMedia` | `navigator.mediaDevices.getUserMedia` | Replaces the acquisition call |
| `audioContext` | global | Creates the `AudioContext`, falling back to `webkitAudioContext` |
| `onWarning` | — | Receives the events in the table above |

## Device quirks handled here

Each of these was found on real hardware and is built into the implementation.

- **The output sink is silenced.** While Bluetooth is connected the `AudioContext`
  routes its output to the headset, and some Android devices cannot establish
  full-duplex audio alongside the microphone input. When that happens the render
  thread stalls and no frames arrive at all. `setSinkId({ type: "none" })` avoids
  opening hardware output. iOS Safari has no `setSinkId`, so it is called only
  where it exists
- **A context that starts suspended is resumed.** On Android Chrome the context
  starts suspended when a `getUserMedia` await comes first, and without a resume no
  frames arrive
- **Only "something else is using it" failures are retried.** `AbortError`,
  `InvalidStateError`, `NotReadableError` and `TrackStartError` get one retry after
  250 ms. Missing permission and missing hardware give the same answer however many
  times you ask, so those are passed straight through
- **A failure during wiring releases the microphone it acquired.** Otherwise an open
  device nobody receives from is stranded, and the next open cannot acquire one
- **Concurrent opens collapse into one.** Letting them through opens a second device
- **An unplugged device closes the bus.** Its track ends and no frame arrives
  again, so the bus closes and reports `device-ended` rather than looking open

## Known limitations

- Built on `ScriptProcessorNode`. It is deprecated, but it is the only path
  confirmed to work everywhere including iOS Safari, so it ships as-is for now. An
  `AudioWorklet` path is under consideration
- No audio processing. Resampling and format conversion belong to the consumer

## License

MIT
