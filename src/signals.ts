export class ShutdownSignalError extends Error {
  readonly signalName: NodeJS.Signals;

  constructor(signalName: NodeJS.Signals) {
    super(`Interrupted by ${signalName}.`);
    this.name = "ShutdownSignalError";
    this.signalName = signalName;
  }
}

export function signalExitCode(signalName: NodeJS.Signals): number {
  return signalName === "SIGINT" ? 130 : signalName === "SIGTERM" ? 143 : 1;
}

export function getShutdownSignalError(signal?: AbortSignal): ShutdownSignalError | undefined {
  const reason = signal?.reason;
  return reason instanceof ShutdownSignalError ? reason : undefined;
}

export function throwIfAborted(signal?: AbortSignal): void {
  const shutdownError = getShutdownSignalError(signal);
  if (shutdownError) {
    throw shutdownError;
  }

  if (signal?.aborted) {
    throw new Error("Operation aborted.");
  }
}

export interface ShutdownController {
  signal: AbortSignal;
  dispose(): void;
}

export function createShutdownController(): ShutdownController {
  const controller = new AbortController();
  const handlers: Array<{ signalName: NodeJS.Signals; handler: () => void }> = [];

  const register = (signalName: NodeJS.Signals): void => {
    const handler = () => {
      if (!controller.signal.aborted) {
        controller.abort(new ShutdownSignalError(signalName));
      }
    };

    process.on(signalName, handler);
    handlers.push({ signalName, handler });
  };

  register("SIGINT");
  register("SIGTERM");

  return {
    signal: controller.signal,
    dispose() {
      for (const { signalName, handler } of handlers) {
        process.off(signalName, handler);
      }
    }
  };
}
