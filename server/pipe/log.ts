/** Pipe errors nobody awaits (a tab attach racing its close); kept out of the relay log unless debugging. */
export function logUnhandledError(error: unknown): void {
  if (process.env.BB_PIPE_DEBUG) console.error("[pipe]", error);
}
