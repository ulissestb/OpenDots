export function createShutdown(options: {
  stopRunner: () => void;
  stopPlatform: () => Promise<void>;
  closeServer: () => Promise<void>;
  exit: (code: number) => void;
  report: (operation: string, error: unknown) => void;
  timeoutMs?: number;
}) {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= (async () => {
      let failed = false;
      const report = (operation: string, error: unknown) => {
        failed = true;
        options.report(operation, error);
      };
      try {
        options.stopRunner();
      } catch (error) {
        report('Stopping scheduler failed', error);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          report('Shutdown deadline exceeded', new Error('Timeout'));
          resolve();
        }, options.timeoutMs ?? 8000);
      });
      const settle = async (operation: string, action: () => Promise<void>) => {
        try {
          await action();
        } catch (error) {
          report(operation, error);
        }
      };
      await Promise.race([
        Promise.all([
          settle('Stopping Channels failed', options.stopPlatform),
          settle('Closing HTTP server failed', options.closeServer),
        ]),
        deadline,
      ]);
      clearTimeout(timer);
      options.exit(failed ? 1 : 0);
    })());
}
/**
 * Stops accepting connections and drops idle keep-alives at once; open
 * streams (agent runs, SSE) get `graceMs` before they are cut, so `close`
 * finishes well within the shutdown deadline.
 */
export function closeHttpServer(
  server: {
    close(callback: (error?: Error) => void): unknown;
    closeIdleConnections?(): void;
    closeAllConnections?(): void;
  },
  graceMs = 3000,
) {
  return new Promise<void>((resolve, reject) => {
    const force = setTimeout(() => server.closeAllConnections?.(), graceMs);
    server.close((error) => {
      clearTimeout(force);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}
