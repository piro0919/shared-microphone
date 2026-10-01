import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMicBus, type MicBusWarning } from "../src/mic-bus";

type FakeTrack = MediaStreamTrack & {
  /** Pretend the device was unplugged. */
  end: () => void;
  stopped: boolean;
};

/** An audio track that records whether it was stopped and can be ended. */
function makeTrack(): FakeTrack {
  const onEnded = new Set<() => void>();
  const track = {
    addEventListener: (type: string, listener: () => void): void => {
      if (type === "ended") onEnded.add(listener);
    },
    end: (): void => {
      for (const listener of [...onEnded]) listener();
    },
    removeEventListener: (type: string, listener: () => void): void => {
      if (type === "ended") onEnded.delete(listener);
    },
    stop: (): void => {
      track.stopped = true;
    },
    stopped: false,
  };
  return track as unknown as FakeTrack;
}

function makeStream(): MediaStream & {
  tracks: ReturnType<typeof makeTrack>[];
} {
  const tracks = [makeTrack()];
  return {
    getTracks: () => tracks,
    tracks,
  } as unknown as MediaStream & { tracks: ReturnType<typeof makeTrack>[] };
}

type FakeContext = {
  closed: boolean;
  createGain: () => unknown;
  createMediaStreamSource: () => unknown;
  createScriptProcessor: (size: number) => FakeProcessor;
  resumed: number;
  state: string;
  processors: FakeProcessor[];
};

type FakeProcessor = {
  connect: () => void;
  disconnect: () => void;
  frameSize: number;
  onaudioprocess: ((event: unknown) => void) | null;
  /** Pretend one frame arrived from the microphone. */
  emit: (samples: Float32Array, sampleRate: number) => void;
};

function makeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  const processors: FakeProcessor[] = [];
  const context: FakeContext = {
    closed: false,
    createGain: () => ({
      connect: () => {},
      disconnect: () => {},
      gain: { value: 1 },
    }),
    createMediaStreamSource: () => ({
      connect: () => {},
      disconnect: () => {},
    }),
    createScriptProcessor: (size: number): FakeProcessor => {
      const processor: FakeProcessor = {
        connect: () => {},
        disconnect: () => {},
        emit: (samples, sampleRate) => {
          processor.onaudioprocess?.({
            inputBuffer: { getChannelData: () => samples, sampleRate },
          });
        },
        frameSize: size,
        onaudioprocess: null,
      };
      processors.push(processor);
      return processor;
    },
    processors,
    resumed: 0,
    state: "running",
    ...overrides,
  };
  Object.assign(context, {
    close: () => {
      context.closed = true;
      return Promise.resolve();
    },
    destination: {},
    resume: () => {
      context.resumed += 1;
      context.state = "running";
      return Promise.resolve();
    },
  });
  return context;
}

type Harness = ReturnType<typeof setup>;

function setup(
  options: {
    contextOverrides?: Partial<FakeContext>;
    getUserMedia?: (
      constraints: MediaStreamConstraints,
    ) => Promise<MediaStream>;
  } = {},
) {
  const contexts: FakeContext[] = [];
  const streams: ReturnType<typeof makeStream>[] = [];
  const warnings: MicBusWarning[] = [];
  const calls: MediaStreamConstraints[] = [];

  const getUserMedia =
    options.getUserMedia ??
    ((constraints: MediaStreamConstraints): Promise<MediaStream> => {
      calls.push(constraints);
      const stream = makeStream();
      streams.push(stream);
      return Promise.resolve(stream);
    });

  const bus = createMicBus({
    audioContext: () => {
      const context = makeContext(options.contextOverrides);
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    getUserMedia: (constraints) => {
      if (options.getUserMedia) calls.push(constraints);
      return getUserMedia(constraints);
    },
    onWarning: (warning) => warnings.push(warning),
  });

  return { bus, calls, contexts, streams, warnings };
}

function processorOf(harness: Harness, index = 0): FakeProcessor {
  const processor = harness.contexts[index]?.processors[0];
  if (!processor) throw new Error("no processor was created");
  return processor;
}

describe("open", () => {
  it("opens the default microphone", async () => {
    const harness = setup();
    await harness.bus.open();
    expect(harness.calls).toEqual([{ audio: true }]);
    expect(harness.bus.isOpen).toBe(true);
  });

  it("opens a named device", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    expect(harness.calls).toEqual([
      { audio: { deviceId: { exact: "mic-1" } } },
    ]);
    expect(harness.bus.deviceId).toBe("mic-1");
  });

  it("does not reopen the same device", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    await harness.bus.open("mic-1");
    // Reopening loses every sample spoken during the gap.
    expect(harness.calls).toHaveLength(1);
  });

  it("reopens on a device change and stops the previous one", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    await harness.bus.open("mic-2");
    expect(harness.calls).toHaveLength(2);
    expect(harness.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.bus.deviceId).toBe("mic-2");
  });

  it("collapses concurrent opens into one", async () => {
    const harness = setup();
    // Letting them through opens a second device.
    await Promise.all([harness.bus.open("mic-1"), harness.bus.open("mic-1")]);
    expect(harness.calls).toHaveLength(1);
  });

  it("resumes a context that starts suspended", async () => {
    // On Android Chrome the context starts suspended when a getUserMedia await
    // comes first. Without a resume, not a single frame arrives.
    const harness = setup({ contextOverrides: { state: "suspended" } });
    await harness.bus.open();
    expect(harness.contexts[0]?.resumed).toBe(1);
  });
});

describe("failures", () => {
  it("retries once, and only for failures worth retrying", async () => {
    vi.useFakeTimers();
    try {
      const error = Object.assign(new Error("busy"), {
        name: "NotReadableError",
      });
      const getUserMedia = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue(makeStream());
      const harness = setup({ getUserMedia });

      const opening = harness.bus.open();
      await vi.advanceTimersByTimeAsync(250);
      await opening;
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a permission failure", async () => {
    const error = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    const getUserMedia = vi.fn().mockRejectedValue(error);
    const harness = setup({ getUserMedia });

    await expect(harness.bus.open()).rejects.toThrow("denied");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default device when the named one fails", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("gone"), { name: "OverconstrainedError" }),
      )
      .mockResolvedValue(makeStream());
    const harness = setup({ getUserMedia });

    await harness.bus.open("mic-gone");
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
    expect(harness.warnings[0]).toMatchObject({
      deviceId: "mic-gone",
      type: "device-fallback",
    });
  });

  it("releases the acquired microphone when wiring fails", async () => {
    // Without this, an open device nobody receives from is stranded, and the
    // next open cannot acquire one.
    const stream = makeStream();
    const harness = setup({
      contextOverrides: {
        createMediaStreamSource: () => {
          throw new Error("attach failed");
        },
      },
      getUserMedia: () => Promise.resolve(stream),
    });

    await expect(harness.bus.open()).rejects.toThrow("attach failed");
    expect(stream.tracks[0]?.stopped).toBe(true);
    expect(harness.bus.isOpen).toBe(false);
  });
});

describe("subscribe", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = setup();
    await harness.bus.open();
  });

  it("delivers incoming frames", () => {
    const first = vi.fn();
    const second = vi.fn();
    harness.bus.subscribe(first);
    harness.bus.subscribe(second);

    const samples = new Float32Array([0.1, 0.2]);
    processorOf(harness).emit(samples, 48000);

    expect(first).toHaveBeenCalledWith(samples, 48000);
    expect(second).toHaveBeenCalledWith(samples, 48000);
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = harness.bus.subscribe(listener);
    unsubscribe();
    processorOf(harness).emit(new Float32Array(1), 48000);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps delivering to the others when one listener throws", () => {
    const failing = vi.fn(() => {
      throw new Error("listener boom");
    });
    const healthy = vi.fn();
    harness.bus.subscribe(failing);
    harness.bus.subscribe(healthy);

    processorOf(harness).emit(new Float32Array(1), 48000);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({ type: "listener-failed" }),
    );
  });

  it("keeps listeners across a close and resumes on reopen", async () => {
    const listener = vi.fn();
    harness.bus.subscribe(listener);
    harness.bus.close();
    expect(harness.bus.isOpen).toBe(false);
    expect(harness.bus.listenerCount).toBe(1);

    await harness.bus.open();
    processorOf(harness, 1).emit(new Float32Array(1), 48000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("close", () => {
  it("releases the microphone and the AudioContext", async () => {
    const harness = setup();
    await harness.bus.open();
    harness.bus.close();

    expect(harness.streams[0]?.tracks[0]?.stopped).toBe(true);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.bus.isOpen).toBe(false);
    expect(harness.bus.deviceId).toBeNull();
  });

  it("does not throw when nothing is open", () => {
    const harness = setup();
    expect(() => harness.bus.close()).not.toThrow();
  });
});

describe("output sink", () => {
  it("silences the sink where supported", async () => {
    // Opening hardware output while Bluetooth is connected stops frames from
    // arriving on some Android devices.
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const harness = setup({ contextOverrides: { setSinkId } as never });
    await harness.bus.open();
    expect(setSinkId).toHaveBeenCalledWith({ type: "none" });
  });

  it("still opens when the sink cannot be silenced", async () => {
    // iOS Safari has no setSinkId.
    const setSinkId = vi.fn().mockRejectedValue(new Error("unsupported"));
    const harness = setup({ contextOverrides: { setSinkId } as never });
    await harness.bus.open();

    expect(harness.bus.isOpen).toBe(true);
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({ type: "sink-not-silenced" }),
    );
  });
});

describe("device fallback", () => {
  it("records the default device, so asking for the named one again retries it", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("gone"), { name: "OverconstrainedError" }),
      )
      .mockImplementation(() => Promise.resolve(makeStream()));
    const harness = setup({ getUserMedia });

    await harness.bus.open("mic-1");
    // The default device is what is open, not mic-1.
    expect(harness.bus.deviceId).toBeNull();

    // mic-1 is back. Asking again must try it, not treat it as already open.
    await harness.bus.open("mic-1");
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "mic-1" } },
    });
    expect(harness.bus.deviceId).toBe("mic-1");
  });

  it("does not reopen the default device after falling back to it", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("gone"), { name: "OverconstrainedError" }),
      )
      .mockImplementation(() => Promise.resolve(makeStream()));
    const harness = setup({ getUserMedia });

    await harness.bus.open("mic-1");
    await harness.bus.open();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});

describe("concurrent opens after a fallback", () => {
  it("collapses them even though the default device ended up open", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("gone"), { name: "OverconstrainedError" }),
      )
      .mockImplementation(() => Promise.resolve(makeStream()));
    const harness = setup({ getUserMedia });

    await Promise.all([
      harness.bus.acquire("mic-1"),
      harness.bus.acquire("mic-1"),
    ]);
    // One failed exact request and one fallback; no second round.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(harness.bus.holderCount).toBe(2);
  });
});

describe("close during an open", () => {
  function deferredStream() {
    let resolve: (stream: MediaStream) => void = () => {};
    const promise = new Promise<MediaStream>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("cancels the open and releases the device it was acquiring", async () => {
    const pending = deferredStream();
    const harness = setup({ getUserMedia: () => pending.promise });

    const opening = harness.bus.open();
    harness.bus.close();
    const stream = makeStream();
    pending.resolve(stream);

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.tracks[0]?.stopped).toBe(true);
    expect(harness.bus.isOpen).toBe(false);
    expect(harness.contexts).toHaveLength(0);
  });

  it("cancels an open that is still wiring the AudioContext", async () => {
    let sinkSet: () => void = () => {};
    const setSinkId = vi.fn(
      () =>
        new Promise<void>((done) => {
          sinkSet = done;
        }),
    );
    const stream = makeStream();
    const harness = setup({
      contextOverrides: { setSinkId } as never,
      getUserMedia: () => Promise.resolve(stream),
    });
    const opening = harness.bus.open();
    // getUserMedia has settled and wiring is waiting on setSinkId.
    await vi.waitFor(() => expect(setSinkId).toHaveBeenCalled());
    harness.bus.close();
    sinkSet();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.tracks[0]?.stopped).toBe(true);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.bus.isOpen).toBe(false);
  });

  it("lets a later open go ahead", async () => {
    const pending = deferredStream();
    const getUserMedia = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(() => Promise.resolve(makeStream()));
    const harness = setup({ getUserMedia });

    const first = harness.bus.open();
    harness.bus.close();
    const second = harness.bus.open();
    pending.resolve(makeStream());

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await second;
    expect(harness.bus.isOpen).toBe(true);
  });
});

describe("acquire", () => {
  it("keeps the microphone open until the last holder releases", async () => {
    const harness = setup();
    const releaseA = await harness.bus.acquire();
    const releaseB = await harness.bus.acquire();
    // One device for both.
    expect(harness.calls).toHaveLength(1);
    expect(harness.bus.holderCount).toBe(2);

    releaseA();
    expect(harness.bus.isOpen).toBe(true);

    releaseB();
    expect(harness.bus.isOpen).toBe(false);
    expect(harness.streams[0]?.tracks[0]?.stopped).toBe(true);
  });

  it("ignores a second release from the same holder", async () => {
    const harness = setup();
    const releaseA = await harness.bus.acquire();
    await harness.bus.acquire();

    releaseA();
    releaseA();
    expect(harness.bus.holderCount).toBe(1);
    expect(harness.bus.isOpen).toBe(true);
  });

  it("drops every reference on close", async () => {
    const harness = setup();
    const release = await harness.bus.acquire();
    harness.bus.close();
    expect(harness.bus.holderCount).toBe(0);

    // A release after close must not close a device someone opened since.
    await harness.bus.open();
    release();
    expect(harness.bus.isOpen).toBe(true);
  });

  it("takes no reference when opening fails", async () => {
    const error = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    const harness = setup({ getUserMedia: () => Promise.reject(error) });

    await expect(harness.bus.acquire()).rejects.toThrow("denied");
    expect(harness.bus.holderCount).toBe(0);
  });
});

describe("device ended", () => {
  it("closes and warns when the track ends", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    harness.streams[0]?.tracks[0]?.end();

    expect(harness.bus.isOpen).toBe(false);
    expect(harness.contexts[0]?.closed).toBe(true);
    expect(harness.warnings).toContainEqual({
      deviceId: "mic-1",
      type: "device-ended",
    });

    await harness.bus.open("mic-1");
    expect(harness.bus.isOpen).toBe(true);
  });

  it("ignores an ended track from a stream it already closed", async () => {
    const harness = setup();
    await harness.bus.open("mic-1");
    await harness.bus.open("mic-2");
    harness.streams[0]?.tracks[0]?.end();

    expect(harness.bus.isOpen).toBe(true);
    expect(harness.warnings).toEqual([]);
  });
});

describe("frameSize", () => {
  it.each([0, 128, 1000, 32768, 4096.5, Number.NaN])(
    "rejects %s",
    (frameSize) => {
      expect(() => createMicBus({ frameSize })).toThrow(RangeError);
    },
  );

  it.each([256, 4096, 16384])("accepts %s", (frameSize) => {
    expect(() => createMicBus({ frameSize })).not.toThrow();
  });
});
