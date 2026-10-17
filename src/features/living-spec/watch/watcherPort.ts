/**
 * Watcher port — the tiny seam that keeps the watch provider swappable.
 *
 * `codexrev spec watch` only ever talks to this interface; the chokidar
 * implementation lives in chokidarWatcher.ts and can be replaced (or faked
 * in tests) without touching the session logic. The session itself is a
 * foreground process: it runs while the command is alive and never installs
 * a daemon, service or git hook.
 */

export type WatchEventKind = 'add' | 'change' | 'unlink';

export interface WatchEvent {
  readonly kind: WatchEventKind;
  /** Project-relative path, forward slashes. */
  readonly path: string;
}

/** Returns true for paths the watch session should analyse. */
export type WatchFilter = (relPath: string) => boolean;

export interface WatcherPort {
  start(): Promise<void>;
  close(): Promise<void>;
  onEvent(handler: (event: WatchEvent) => void): void;
  onError(handler: (error: Error) => void): void;
}

export type WatcherFactory = (projectRoot: string, shouldWatch: WatchFilter) => WatcherPort;
