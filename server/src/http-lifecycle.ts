import type { Server, Socket } from 'node:net';

export interface GracefulShutdownOptions {
  drainTimeoutMs?: number;
  onDrain?: () => void;
  onClose?: () => void | Promise<void>;
}

export interface GracefulShutdown {
  shutdown(): Promise<void>;
  isDraining(): boolean;
}

/** Stop accepting work, notify upgrade handlers, drain active sockets, then clean up. */
export function installGracefulShutdown(server: Server, options: GracefulShutdownOptions = {}): GracefulShutdown {
  const drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) {
    throw new RangeError('drainTimeoutMs must be a positive safe integer');
  }
  const sockets = new Set<Socket>();
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    draining = true;
    options.onDrain?.();
    let resolveClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    server.close((error) => error ? rejectClosed(error) : resolveClosed());
    shutdownPromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), drainTimeoutMs);
        timer.unref();
      });
      try {
        const result = await Promise.race([closed.then(() => 'closed' as const), deadline]);
        if (result === 'deadline') {
          for (const socket of sockets) socket.destroy();
          await closed;
        }
        await options.onClose?.();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return shutdownPromise;
  };

  const onSignal = () => {
    void shutdown().then(
      () => { process.exit(0); },
      () => { process.exit(1); },
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  server.once('close', () => {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  });

  return { shutdown, isDraining: () => draining };
}
