"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createMicBus, type MicBusWarning } from "../index";

/* The exported `micBus` with a warning handler attached, so the events the bus
   keeps running through are visible here instead of silent. */
let warningSink: ((warning: MicBusWarning) => void) | null = null;

const bus = createMicBus({
  onWarning: (warning) => warningSink?.(warning),
});

type Lane = {
  accent: string;
  id: string;
  name: string;
  reads: string;
};

const LANES: Lane[] = [
  {
    accent: "#38bdf8",
    id: "waveform",
    name: "Waveform",
    reads: "every sample of every frame",
  },
  {
    accent: "#34d399",
    id: "level",
    name: "Level meter",
    reads: "the loudest sample so far",
  },
  {
    accent: "#c084fc",
    id: "counter",
    name: "Frame counter",
    reads: "how many frames arrived",
  },
];

type LaneState = {
  frames: number;
  level: number;
  peak: number;
  samples: number;
  waveform: number[];
};

const EMPTY: LaneState = {
  frames: 0,
  level: 0,
  peak: 0,
  samples: 0,
  waveform: [],
};

const BARS = 64;
const BAR_IDS = Array.from({ length: BARS }, (_, i) => `bar-${i}`);

/** Reduce one frame to the handful of numbers a lane displays. */
function summarize(previous: LaneState, samples: Float32Array): LaneState {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
    sum += value;
  }
  return {
    frames: previous.frames + 1,
    level: sum / Math.max(1, samples.length),
    peak: Math.max(previous.peak, peak),
    samples: previous.samples + samples.length,
    waveform: [...previous.waveform, peak].slice(-BARS),
  };
}

export default function Home() {
  const [error, setError] = useState<null | string>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [opening, setOpening] = useState(false);
  const [sampleRate, setSampleRate] = useState<null | number>(null);
  const [states, setStates] = useState<Record<string, LaneState>>({});
  const [warnings, setWarnings] = useState<{ id: number; text: string }[]>([]);
  const offs = useRef<Record<string, () => void>>({});

  useEffect(() => {
    let nextId = 0;
    warningSink = (warning) =>
      setWarnings((previous) => [
        ...previous,
        { id: nextId++, text: warning.type },
      ]);
    return () => {
      warningSink = null;
    };
  }, []);

  // Release the device when the page goes away. Nothing else here closes it:
  // attaching and detaching lanes never touches the microphone.
  useEffect(() => {
    return () => {
      for (const off of Object.values(offs.current)) off();
      bus.close();
    };
  }, []);

  const toggleDevice = useCallback(async () => {
    if (isOpen) {
      bus.close();
      setIsOpen(false);
      return;
    }
    setError(null);
    setOpening(true);
    try {
      await bus.open();
      setIsOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  }, [isOpen]);

  const toggleLane = useCallback((lane: Lane) => {
    setOn((previous) => {
      const next = !previous[lane.id];
      if (next) {
        setStates((s) => ({ ...s, [lane.id]: EMPTY }));
        offs.current[lane.id] = bus.subscribe((samples, rate) => {
          setSampleRate(rate);
          setStates((s) => ({
            ...s,
            [lane.id]: summarize(s[lane.id] ?? EMPTY, samples),
          }));
        });
      } else {
        offs.current[lane.id]?.();
        delete offs.current[lane.id];
      }
      return { ...previous, [lane.id]: next };
    });
  }, []);

  const attached = LANES.filter((lane) => on[lane.id]).length;

  return (
    <div className="flex min-h-screen flex-col bg-[#0b0b0f] text-zinc-200">
      {/* The device is the page's chrome, not a card. It stays open across
          everything else that happens below. */}
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-zinc-800 bg-[#0b0b0f]/95 px-6 py-4 backdrop-blur">
        <div className="mr-auto">
          <h1 className="font-display text-lg font-bold tracking-tight text-white">
            shared-microphone
          </h1>
          <p className="text-xs text-zinc-500">
            One device. However many listeners.
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs text-zinc-400">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              isOpen ? "bg-sky-400" : "bg-zinc-700"
            }`}
          />
          {isOpen ? `open · ${sampleRate ?? "—"} Hz` : "closed"}
          <span className="text-zinc-600">·</span>
          {attached} listening
        </div>

        <button
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-50"
          disabled={opening}
          onClick={toggleDevice}
          type="button"
        >
          {opening ? "opening…" : isOpen ? "close device" : "open device"}
        </button>
      </header>

      {error ? (
        <p className="border-b border-red-900/50 bg-red-950/40 px-6 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {/* The bus itself: one source at the top, a trunk down the left, and a
          branch into every lane. The trunk is the lanes' own left edge, so it
          cannot drift away from them. */}
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="flex items-center gap-4">
          <div
            className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full transition-colors ${
              isOpen ? "bg-sky-500" : "bg-zinc-800"
            }`}
          >
            <svg
              aria-hidden="true"
              className={isOpen ? "text-sky-950" : "text-zinc-600"}
              fill="currentColor"
              height="32"
              viewBox="0 0 24 24"
              width="32"
            >
              <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm7 9a7 7 0 0 1-6 6.93V22h-2v-3.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0h2Z" />
            </svg>
          </div>
          <p className="font-mono text-xs leading-relaxed text-zinc-500">
            getUserMedia called once
            <span className="mt-0.5 block text-zinc-600">
              every lane below reads these same frames
            </span>
          </p>
        </div>

        {/* The trunk is the lanes' own left border, so it starts under the
            microphone and ends with the last lane. It cannot drift. */}
        <div
          className={`ml-8 flex flex-col border-l pl-8 transition-colors ${
            isOpen ? "border-sky-500/50" : "border-zinc-800"
          }`}
        >
          {LANES.map((lane) => {
            const state = states[lane.id] ?? EMPTY;
            const live = Boolean(on[lane.id]);
            return (
              <button
                className="group flex items-center gap-6 rounded-r-lg py-7 text-left transition-colors hover:bg-zinc-900/50"
                key={lane.id}
                onClick={() => toggleLane(lane)}
                type="button"
              >
                {/* the branch off the trunk */}
                <span
                  className="-ml-8 h-px w-8 shrink-0 transition-colors"
                  style={{ background: live ? lane.accent : "#27272a" }}
                />

                <span className="w-44 shrink-0">
                  <span className="block font-mono text-sm text-white">
                    {lane.name}
                  </span>
                  <span className="mt-1 block text-xs text-zinc-500">
                    reads {lane.reads}
                  </span>
                  <span
                    className="mt-3 inline-block rounded px-2 py-0.5 font-mono text-[10px] transition-colors"
                    style={{
                      background: live ? `${lane.accent}22` : "#1c1c20",
                      color: live ? lane.accent : "#71717a",
                    }}
                  >
                    {live ? "subscribed" : "click to subscribe"}
                  </span>
                </span>

                <span
                  className={`flex flex-1 items-center transition-opacity ${
                    live ? "opacity-100" : "opacity-30"
                  }`}
                >
                  {lane.id === "waveform" ? (
                    <span className="flex h-16 w-full items-end gap-px">
                      {BAR_IDS.map((id, i) => (
                        <span
                          className="flex-1 rounded-sm"
                          key={id}
                          style={{
                            background: lane.accent,
                            height: `${Math.max(2, Math.min(100, (state.waveform[i] ?? 0) * 200))}%`,
                          }}
                        />
                      ))}
                    </span>
                  ) : lane.id === "level" ? (
                    <span className="w-full">
                      <span className="block h-2.5 w-full overflow-hidden rounded-full bg-zinc-900">
                        <span
                          className="block h-full rounded-full transition-[width] duration-75"
                          style={{
                            background: lane.accent,
                            width: `${Math.min(100, state.level * 400)}%`,
                          }}
                        />
                      </span>
                      <span className="mt-2 block font-mono text-xs text-zinc-500">
                        peak {state.peak.toFixed(3)}
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono text-3xl text-zinc-300">
                      {state.frames.toLocaleString("en-US")}
                      <span className="ml-2 text-xs text-zinc-600">frames</span>
                      <span className="mt-1 block text-xs text-zinc-600">
                        {state.samples.toLocaleString("en-US")} samples
                      </span>
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </main>

      <p className="px-6 pb-6 text-xs leading-relaxed text-zinc-600">
        Attach and detach lanes while the device stays open. Nothing here
        reopens the microphone, which is the point: with one{" "}
        <code>getUserMedia</code> per consumer, every switch costs a few hundred
        milliseconds of audio.
      </p>

      {warnings.length > 0 ? (
        <ul className="px-6 pb-4 font-mono text-xs text-amber-400">
          {warnings.map((warning) => (
            <li key={warning.id}>{warning.text}</li>
          ))}
        </ul>
      ) : null}

      <footer className="flex flex-wrap items-center gap-4 border-t border-zinc-800 px-6 py-5 text-sm">
        <code className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-xs text-zinc-300">
          npm i shared-microphone
        </code>
        <a
          className="text-zinc-500 transition-colors hover:text-zinc-300"
          href="https://github.com/piro0919/shared-microphone"
          rel="noreferrer"
          target="_blank"
        >
          GitHub →
        </a>
        <a
          className="text-zinc-500 transition-colors hover:text-zinc-300"
          href="https://buymeacoffee.com/piro0919"
          rel="noreferrer"
          target="_blank"
        >
          Buy Me a Coffee →
        </a>
        <a
          className="text-zinc-500 transition-colors hover:text-zinc-300"
          href="https://www.npmjs.com/package/shared-microphone"
          rel="noreferrer"
          target="_blank"
        >
          npm →
        </a>
        <a
          className="ml-auto text-zinc-600 transition-colors hover:text-zinc-400"
          href="https://kkweb.io/"
          rel="noreferrer"
          target="_blank"
        >
          kkweb.io
        </a>
      </footer>
    </div>
  );
}
