import { createMicBus } from "./mic-bus";

export {
  createMicBus,
  type MicBus,
  type MicBusOptions,
  type MicBusWarning,
  type MicFrameListener,
  type MicRelease,
} from "./mic-bus";

/**
 * The shared microphone.
 *
 * There is only one device to open, so this instance is usually the one to use.
 */
export const micBus = createMicBus();
