import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'path';
import { WatchConfigService } from './config.js';
import type { CursorState, SeenCommentState } from './types.js';

const SIDECAR_SUFFIX = '.comments.json';
const CLEANUP_INTERVAL_MS = 60_000;

export interface RawWatchResult {
  changedFiles: string[];
  timedOut: boolean;
  sessionExpired: boolean;
  watchError: boolean;
  cursor: string;
}

interface ActiveWatch {
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  resolve: ((result: RawWatchResult) => void) | null;
  cursorId: string;
}

export class FileWatcherService {
  private vaultPath: string;
  private cursors: Map<string, CursorState> = new Map();
  private activeWatches: Map<string, ActiveWatch> = new Map();
  private cursorCounter = 0;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    vaultPath: string,
    private configService: WatchConfigService
  ) {
    this.vaultPath = resolve(vaultPath);

    // Periodic cleanup of expired sessions to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      const config = this.configService.getConfig();
      this.cleanupExpiredSessions(config.sessionTimeout);
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Validate that folder is within the vault boundary.
   * Prevents path traversal (e.g., '../../etc').
   */
  private validateFolder(folder: string): string {
    const fullFolder = resolve(this.vaultPath, folder);
    if (!fullFolder.startsWith(this.vaultPath + '/') && fullFolder !== this.vaultPath) {
      throw new Error(`Folder must be within vault: ${folder}`);
    }
    return fullFolder;
  }

  async watch(
    folder: string,
    cursorId?: string,
    agentName?: string
  ): Promise<RawWatchResult> {
    const config = this.configService.resolveForAgent(agentName);

    // Validate folder is within vault
    const fullFolder = this.validateFolder(folder);

    // Check max concurrent
    if (this.activeWatches.size >= config.maxConcurrent) {
      throw new Error(`Maximum concurrent watches reached (${config.maxConcurrent})`);
    }

    // Resolve or create cursor
    let cursor: CursorState;
    if (cursorId) {
      const existing = this.decodeCursor(cursorId);
      if (!existing) {
        // Invalid/expired cursor — create fresh
        cursor = this.createCursor(folder, agentName || 'unknown');
      } else {
        // Check session expiry
        const sessionAge = (Date.now() - existing.sessionStart.getTime()) / 1000;
        if (sessionAge >= config.sessionTimeout) {
          this.cursors.delete(cursorId);
          return {
            changedFiles: [],
            timedOut: false,
            sessionExpired: true,
            watchError: false,
            cursor: cursorId,
          };
        }
        cursor = existing;
      }
    } else {
      cursor = this.createCursor(folder, agentName || 'unknown');
    }

    return new Promise<RawWatchResult>((resolvePromise) => {
      let resolved = false;
      const changedFiles = new Set<string>();

      const cleanup = () => {
        if (activeWatch.watcher) {
          activeWatch.watcher.close();
          activeWatch.watcher = null;
        }
        if (activeWatch.timer) {
          clearTimeout(activeWatch.timer);
          activeWatch.timer = null;
        }
        if (activeWatch.debounceTimer) {
          clearTimeout(activeWatch.debounceTimer);
          activeWatch.debounceTimer = null;
        }
        activeWatch.resolve = null;
        this.activeWatches.delete(cursor.id);
      };

      const complete = (result: RawWatchResult) => {
        if (resolved) return; // Guard against double-resolve
        resolved = true;
        cleanup();
        cursor.lastChecked = new Date();
        resolvePromise(result);
      };

      const activeWatch: ActiveWatch = {
        watcher: null,
        timer: null,
        debounceTimer: null,
        resolve: resolvePromise,
        cursorId: cursor.id,
      };
      this.activeWatches.set(cursor.id, activeWatch);

      // Set up timeout
      activeWatch.timer = setTimeout(() => {
        complete({
          changedFiles: [],
          timedOut: true,
          sessionExpired: false,
          watchError: false,
          cursor: cursor.id,
        });
      }, config.pollTimeout * 1000);

      // Set up fs.watch
      // Note: { recursive: true } is supported on macOS (FSEvents) and Windows.
      // On Linux, it may silently degrade to non-recursive. If cross-platform
      // recursive watching is needed, consider chokidar.
      try {
        activeWatch.watcher = watch(fullFolder, { recursive: true }, (_eventType, filename) => {
          if (!filename || !filename.endsWith(SIDECAR_SUFFIX)) return;

          changedFiles.add(filename);

          // Debounce: wait 100ms after last change before resolving
          if (activeWatch.debounceTimer) clearTimeout(activeWatch.debounceTimer);
          activeWatch.debounceTimer = setTimeout(() => {
            complete({
              changedFiles: [...changedFiles],
              timedOut: false,
              sessionExpired: false,
              watchError: false,
              cursor: cursor.id,
            });
          }, 100);
        });

        activeWatch.watcher.on('error', () => {
          complete({
            changedFiles: [],
            timedOut: false,
            sessionExpired: false,
            watchError: true,
            cursor: cursor.id,
          });
        });
      } catch {
        // fs.watch failed to start
        cleanup();
        resolvePromise({
          changedFiles: [],
          timedOut: false,
          sessionExpired: false,
          watchError: true,
          cursor: cursor.id,
        });
      }
    });
  }

  createCursor(folder: string, agentName: string): CursorState {
    const id = 'w_' + (++this.cursorCounter).toString(36) + '_' + Date.now().toString(36);
    const now = new Date();

    const cursor: CursorState = {
      id,
      folder,
      agentName,
      sessionStart: now,
      lastChecked: now,
      seenComments: new Map(),
    };

    this.cursors.set(id, cursor);
    return cursor;
  }

  decodeCursor(cursorId: string): CursorState | null {
    return this.cursors.get(cursorId) || null;
  }

  updateCursor(cursorId: string, seenComments: Map<string, SeenCommentState>): void {
    const cursor = this.cursors.get(cursorId);
    if (cursor) {
      cursor.seenComments = seenComments;
      cursor.lastChecked = new Date();
    }
  }

  cancel(cursorId: string): void {
    const activeWatch = this.activeWatches.get(cursorId);
    if (activeWatch) {
      if (activeWatch.watcher) {
        activeWatch.watcher.close();
        activeWatch.watcher = null;
      }
      if (activeWatch.timer) {
        clearTimeout(activeWatch.timer);
        activeWatch.timer = null;
      }
      if (activeWatch.debounceTimer) {
        clearTimeout(activeWatch.debounceTimer);
        activeWatch.debounceTimer = null;
      }
      const resolveFn = activeWatch.resolve;
      activeWatch.resolve = null;
      this.activeWatches.delete(cursorId);
      if (resolveFn) {
        resolveFn({
          changedFiles: [],
          timedOut: false,
          sessionExpired: false,
          watchError: false,
          cursor: cursorId,
        });
      }
    }
  }

  getActiveWatchCount(): number {
    return this.activeWatches.size;
  }

  cleanupExpiredSessions(maxSessionTimeout: number): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, cursor] of this.cursors) {
      const sessionAge = (now - cursor.sessionStart.getTime()) / 1000;
      if (sessionAge >= maxSessionTimeout) {
        this.cancel(id);
        this.cursors.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    // Collect IDs first — cancel() mutates activeWatches
    const ids = [...this.activeWatches.keys()];
    for (const id of ids) {
      this.cancel(id);
    }
    this.cursors.clear();
  }
}
