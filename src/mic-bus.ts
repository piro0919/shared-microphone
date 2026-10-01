/**
 * Open the microphone once and share its audio frames with every consumer.
 *
 * When two or more things need the same audio — wake word detection and
 * transcription, say — having each of them call `getUserMedia` means the device
 * is reopened every time you switch between them. Reopening takes hundreds of
 * milliseconds on some hardware, and whatever is said during that window is lost
 * entirely. Wake word matching falls below its threshold when the start of an
 * utterance is clipped, so this shows up as the wake word simply not firing
 * rather than as a delay.
 */

/** Receives audio frames. `samples` is single-channel Float32 in the -1..1 range. */
export type MicFrameListener = (
  samples: Float32Array,
  sampleRate: number,
) => void;

/**
 * Failures worth one retry.
 *
 * "Something else is using it right now" often clears on its own. Missing
 * permission, missing API and missing hardware give the same answer however many
 * times you ask, so those are passed straight through.
 */
const RETRIABLE_ERRORS = new Set([
  "AbortError",
  "InvalidStateError",
  "NotReadableError",
  "TrackStartError",
]);

/** ScriptProcessor granularity. At 48 kHz one frame arrives roughly every 85 ms. */
const DEFAULT_FRAME_SIZE = 4096;
/** The buffer sizes `createScriptProcessor` accepts. */
const MIN_FRAME_SIZE = 256;
const MAX_FRAME_SIZE = 16384;
const RETRY_DELAY_MS = 250;

export type MicBusWarning =
  /**
   * The requested device could not be opened, so the default one is in use.
   * `deviceId` is the one that was requested; the bus reports `null` while on the
   * default, and opening the requested device again tries it again.
   */
  | { deviceId: string; error: unknown; type: "device-fallback" }
  /**
   * The open device stopped delivering audio — it was unplugged, or the browser
   * or OS revoked it. The bus has closed. `deviceId` is the device that ended,
   * `null` for the default one. Listeners stay attached; holders from `acquire()`
   * stay counted, and the next `open()` or `acquire()` reopens.
   */
  | { deviceId: null | string; type: "device-ended" }
  /** A listener threw. Delivery to the others continued. */
  | { error: unknown; type: "listener-failed" }
  /** The output sink could not be silenced. Playback still works on most devices. */
  | { error: unknown; type: "sink-not-silenced" };

export type MicBusOptions = {
  /** Creates the `AudioContext`. Defaults to the global one, falling back to `webkitAudioContext`. */
  audioContext?: () => AudioContext;
  /**
   * Samples per frame. A power of two from 256 to 16384, as `createScriptProcessor`
   * requires. Defaults to 4096. Anything else throws a `RangeError` from
   * `createMicBus`.
   */
  frameSize?: number;
  /** Replaces `navigator.mediaDevices.getUserMedia`. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Events that do not stop the bus but are worth surfacing, e.g. as a toast. */
  onWarning?: (warning: MicBusWarning) => void;
};

/** Gives back a reference taken with `acquire()`. Calling it again does nothing. */
export type MicRelease = () => void;

export type MicBus = {
  /**
   * The open device, or null for the default one. Also null while closed, and
   * null after a requested device failed and the default one was opened instead.
   */
  readonly deviceId: null | string;
  /** How many references taken with `acquire()` are still held. */
  readonly holderCount: number;
  /** Whether the microphone is currently open. */
  readonly isOpen: boolean;
  /** How many listeners are attached. */
  readonly listenerCount: number;
  /**
   * Take a reference to the microphone and open it if needed. The microphone
   * stays open until every reference is released, so one consumer finishing does
   * not cut off another. Call the returned function to release.
   *
   * There is still one device: acquiring with a different `deviceId` switches it
   * for every holder, as `open()` does. If opening fails, no reference is taken
   * and the promise rejects.
   */
  acquire: (deviceId?: null | string) => Promise<MicRelease>;
  /**
   * Close the microphone now, whoever holds it. Every reference from `acquire()`
   * is dropped (their release functions become no-ops) and an `open()` still in
   * flight is cancelled: it rejects with an `AbortError` and the device it was
   * acquiring is released. Listeners stay attached and resume on the next open.
   *
   * Consumers that share the bus should use `acquire()` and release instead.
   */
  close: () => void;
  /**
   * Open the microphone. Does nothing if the same device is already open.
   * Reopens when the requested device changed. Takes no reference: the device
   * stays open until `close()`, or until the last `acquire()` holder releases.
   */
  open: (deviceId?: null | string) => Promise<void>;
  /** Start receiving audio frames. Call the returned function to stop. */
  subscribe: (listener: MicFrameListener) => () => void;
};

type State = {
  audioContext: AudioContext | null;
  /** What `open()` compares against: null when the default device is in use. */
  deviceId: null | string;
  processor: null | ScriptProcessorNode;
  silentGain: GainNode | null;
  source: MediaStreamAudioSourceNode | null;
  stream: MediaStream | null;
};

type WindowWithWebkit = {
  webkitAudioContext?: typeof AudioContext;
} & Window;

function defaultAudioContext(): AudioContext {
  const impl =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as WindowWithWebkit).webkitAudioContext);
  if (!impl) {
    throw new Error("AudioContext is not supported in this environment");
  }
  return new impl();
}

function abortError(): Error {
  const error = new Error("The microphone was closed while it was opening");
  error.name = "AbortError";
  return error;
}

function defaultGetUserMedia(
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return Promise.reject(
      new Error("navigator.mediaDevices is not available in this environment"),
    );
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Create a microphone bus.
 *
 * One is usually enough, so reach for the exported `micBus` first. Create your own
 * for tests, or when you genuinely need to drive several devices at once.
 */
export function createMicBus(options: MicBusOptions = {}): MicBus {
  const frameSize = options.frameSize ?? DEFAULT_FRAME_SIZE;
  // createScriptProcessor would reject a bad size only on the first open, far from
  // the code that chose it.
  if (
    !Number.isInteger(frameSize) ||
    frameSize < MIN_FRAME_SIZE ||
    frameSize > MAX_FRAME_SIZE ||
    (frameSize & (frameSize - 1)) !== 0
  ) {
    throw new RangeError(
      `frameSize must be a power of two from ${MIN_FRAME_SIZE} to ${MAX_FRAME_SIZE}, got ${frameSize}`,
    );
  }
  const getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
  const makeAudioContext = options.audioContext ?? defaultAudioContext;
  const listeners = new Set<MicFrameListener>();
  const state: State = {
    audioContext: null,
    deviceId: null,
    processor: null,
    silentGain: null,
    source: null,
    stream: null,
  };
  // Collapse concurrent opens into one. Letting them through opens a second device.
  let openInFlight: null | Promise<void> = null;
  let openInFlightFor: null | string = null;
  // Bumped by close(). An open that started under an older value was cancelled.
  let generation = 0;
  const holders = new Set<symbol>();
  let detachEnded: (() => void) | null = null;

  function warn(warning: MicBusWarning): void {
    options.onWarning?.(warning);
  }

  async function acquire(
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> {
    try {
      return await getUserMedia(constraints);
    } catch (error) {
      const name =
        error && typeof error === "object" && "name" in error
          ? String((error as { name: unknown }).name)
          : "";
      if (!RETRIABLE_ERRORS.has(name)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return getUserMedia(constraints);
    }
  }

  /** The stream, and the device it is actually on: null for the default one. */
  async function getStream(
    deviceId: null | string,
  ): Promise<{ deviceId: null | string; stream: MediaStream }> {
    if (!deviceId)
      return { deviceId: null, stream: await acquire({ audio: true }) };
    try {
      const stream = await acquire({
        audio: { deviceId: { exact: deviceId } },
      });
      return { deviceId, stream };
    } catch (error) {
      // The chosen microphone may have been unplugged. Fall back and keep going,
      // and record the default as what is open, so a later open(deviceId) tries
      // the requested device again instead of treating it as already open.
      warn({ deviceId, error, type: "device-fallback" });
      return { deviceId: null, stream: await acquire({ audio: true }) };
    }
  }

  function teardown(): void {
    detachEnded?.();
    detachEnded = null;
    if (state.processor) {
      state.processor.onaudioprocess = null;
      state.processor.disconnect();
      state.processor = null;
    }
    if (state.silentGain) {
      state.silentGain.disconnect();
      state.silentGain = null;
    }
    if (state.source) {
      state.source.disconnect();
      state.source = null;
    }
    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
    }
    if (state.audioContext) {
      if (state.audioContext.state !== "closed") {
        void state.audioContext.close().catch(() => {});
      }
      state.audioContext = null;
    }
    state.deviceId = null;
  }

  async function attach(
    stream: MediaStream,
    deviceId: null | string,
    isCancelled: () => boolean,
  ): Promise<void> {
    const audioContext = makeAudioContext();
    try {
      await wire(audioContext, stream, deviceId, isCancelled);
    } catch (error) {
      if (audioContext.state !== "closed") {
        void audioContext.close().catch(() => {});
      }
      throw error;
    }
  }

  async function wire(
    audioContext: AudioContext,
    stream: MediaStream,
    deviceId: null | string,
    isCancelled: () => boolean,
  ): Promise<void> {
    // Recording needs no speaker output. While Bluetooth is connected the
    // AudioContext routes its output to the headset, and some Android devices
    // cannot establish full-duplex SCO alongside the microphone input. When that
    // happens the render thread stalls and onaudioprocess stops firing entirely.
    // A silent sink avoids opening hardware output at all. iOS Safari has no
    // setSinkId, so only call it where it exists.
    const withSink = audioContext as {
      setSinkId?: (sinkId: string | { type: "none" }) => Promise<void>;
    } & AudioContext;
    if (typeof withSink.setSinkId === "function") {
      try {
        await withSink.setSinkId({ type: "none" });
      } catch (error) {
        warn({ error, type: "sink-not-silenced" });
      }
    }

    // On Android Chrome the context starts suspended when a getUserMedia await
    // comes first. Without a resume, onaudioprocess never fires. Resuming an
    // already-running context is a no-op.
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (isCancelled()) throw abortError();

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(frameSize, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event): void => {
      const input = event.inputBuffer.getChannelData(0);
      const sampleRate = event.inputBuffer.sampleRate;
      // One listener throwing must not stop delivery to the others.
      for (const listener of [...listeners]) {
        try {
          listener(input, sampleRate);
        } catch (error) {
          warn({ error, type: "listener-failed" });
        }
      }
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    // An unplugged device ends its track and no frame ever arrives again. Close
    // and say so, rather than look open while delivering nothing.
    const onEnded = (): void => {
      if (state.stream !== stream) return;
      const ended = state.deviceId;
      teardown();
      warn({ deviceId: ended, type: "device-ended" });
    };
    const tracks = stream.getTracks();
    for (const track of tracks) track.addEventListener("ended", onEnded);
    detachEnded = (): void => {
      for (const track of tracks) track.removeEventListener("ended", onEnded);
    };

    state.audioContext = audioContext;
    state.deviceId = deviceId;
    state.processor = processor;
    state.silentGain = silentGain;
    state.source = source;
    state.stream = stream;
  }

  async function openOnce(
    requested: null | string,
    isCancelled: () => boolean,
  ): Promise<void> {
    const { deviceId, stream } = await getStream(requested);
    try {
      if (isCancelled()) throw abortError();
      await attach(stream, deviceId, isCancelled);
    } catch (error) {
      // Failing here leaves the acquired microphone out of reach of teardown(),
      // because it is not in state yet. That would strand an open device nobody
      // receives from, and the next open would fail to acquire one. Release what
      // we took.
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
  }

  async function open(deviceId: null | string = null): Promise<void> {
    if (openInFlight) {
      const sameRequest = openInFlightFor === deviceId;
      await openInFlight;
      // Also return when that open fell back to the default device: asking for the
      // same missing device again straight away would only fail the same way.
      if (state.stream && (sameRequest || state.deviceId === deviceId)) return;
    }
    if (state.stream && state.deviceId === deviceId) return;

    const started = generation;
    const isCancelled = (): boolean => generation !== started;
    const opening = (async (): Promise<void> => {
      if (state.stream) teardown();
      try {
        await openOnce(deviceId, isCancelled);
      } catch (error) {
        // A cancelled open must not tear down what a later open set up.
        if (!isCancelled()) teardown();
        throw error;
      }
    })().finally(() => {
      if (openInFlight === opening) openInFlight = null;
    });
    openInFlight = opening;
    openInFlightFor = deviceId;

    await opening;
  }

  return {
    async acquire(deviceId: null | string = null): Promise<MicRelease> {
      const token = Symbol("mic-holder");
      holders.add(token);
      try {
        await open(deviceId);
      } catch (error) {
        if (holders.delete(token) && holders.size === 0) teardown();
        throw error;
      }
      return (): void => {
        // Already released, or dropped by close().
        if (!holders.delete(token)) return;
        if (holders.size === 0) teardown();
      };
    },
    close(): void {
      generation += 1;
      openInFlight = null;
      holders.clear();
      teardown();
    },
    get deviceId(): null | string {
      return state.deviceId;
    },
    get holderCount(): number {
      return holders.size;
    },
    get isOpen(): boolean {
      return state.stream !== null;
    },
    get listenerCount(): number {
      return listeners.size;
    },
    open,
    subscribe(listener: MicFrameListener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
