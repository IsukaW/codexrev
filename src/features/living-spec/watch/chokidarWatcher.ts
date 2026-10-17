/**
 * chokidar-backed implementation of `WatcherPort`.
 *
 * chokidar is the approved watcher from the research tech stack. It is kept
 * behind `WatcherPort` so the provider stays swappable, and it is only ever
 * alive for the duration of the foreground `codexrev spec watch` session.
 */

import nodePath from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { LivingSpecWatchError } from '../tools/errors.js';
import { isAlwaysExcludedPath, normalizeRelPath } from '../tools/pathMatcher.js';
import type { WatchEvent, WatchEventKind, WatcherFactory, WatcherPort } from './watcherPort.js';

const EVENT_KINDS: readonly WatchEventKind[] = ['add', 'change', 'unlink'];

function toRelPath(projectRoot: string, p: string): string {
  if (nodePath.isAbsolute(p)) return normalizeRelPath(nodePath.relative(projectRoot, p));
  return normalizeRelPath(p);
}

export const createChokidarWatcher: WatcherFactory = (
  projectRoot: string,
  shouldWatch,
): WatcherPort => {
  const eventHandlers: Array<(event: WatchEvent) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  let fsWatcher: FSWatcher | undefined;

  return {
    async start(): Promise<void> {
      if (fsWatcher) return;
      let watcher: FSWatcher;
      try {
        watcher = watch(projectRoot, {
          persistent: true,
          ignoreInitial: true,
          cwd: projectRoot, // event paths come back project-relative
          disableGlobbing: true,
          ignored: (p: string) =>
            // prune node_modules/dist/.git/.codexrev early so they are never
            // scanned; file-level glob filtering happens on the events
            isAlwaysExcludedPath(toRelPath(projectRoot, p)),
        });
      } catch (err) {
        throw new LivingSpecWatchError(
          `failed to watch "${projectRoot}": ${(err as Error).message ?? String(err)}`,
        );
      }

      for (const kind of EVENT_KINDS) {
        watcher.on(kind, (changedPath: string) => {
          const relPath = toRelPath(projectRoot, changedPath);
          if (!shouldWatch(relPath)) return;
          const event: WatchEvent = { kind, path: relPath };
          for (const handler of eventHandlers) handler(event);
        });
      }
      watcher.on('error', (error: Error) => {
        for (const handler of errorHandlers) handler(error);
      });
      fsWatcher = watcher;
    },

    async close(): Promise<void> {
      const watcher = fsWatcher;
      fsWatcher = undefined;
      if (watcher) await watcher.close();
    },

    onEvent(handler: (event: WatchEvent) => void): void {
      eventHandlers.push(handler);
    },

    onError(handler: (error: Error) => void): void {
      errorHandlers.push(handler);
    },
  };
};
