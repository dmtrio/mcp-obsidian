import { watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'path';
import { WatchConfigService } from './config.js';
import type { CursorState, SeenCommentState } from './types.js';

const SIDECAR_SUFFIX = '.comments.json';

export interface RawWatchResult {
  changedFiles: string[];
  timedOut: boolean;
  sessionExpired: boolean;
  cursor: string;
}

interface ActiveWatch {
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: ((result: RawWatchResult) => void) | null;
  cursorId: string;
}

export class FileWatcherService {
  private vaultPath: string;
  private cursors: Map<string, CursorState> = new Map();
  private activeWatches: Map<string, ActiveWatch> = new Map();
  private cursorCounter = 0;

  constructor(
    vaultPath: string,
    private configService: WatchConfigService
  ) {
    this.vaultPath = resolve(vaultPath);
  }

  async watch(
    folder: string,
    cursorId?: string,
    agentName?: string
  ): Promise<RawWatchResult> {
    const config = this.configService.resolveForAgent(agentName);

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
        cursor = await this.createCursor(folder, agentName || 'unknown');
      } else {
        // Check session expiry
        const sessionAge = (Date.now() - existing.sessionStart.getTime()) / 1000;
        if (sessionAge >= config.sessionTimeout) {
          this.cursors.delete(cursorId);
          return {
            changedFiles: [],
            timedOut: false,
            sessionExpired: true,
            cursor: cursorId,
          };
        }
        cursor = existing;
      }
    } else {
      cursor = await this.createCursor(folder, agentName || 'unknown');
    }

    const fullFolder = join(this.vaultPath, folder);

    return new Promise<RawWatchResult>((resolvePromise) => {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
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
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        this.activeWatches.delete(cursor.id);
      };

      const complete = (result: RawWatchResult) => {
        cleanup();
        cursor.lastChecked = new Date();
        resolvePromise(result);
      };

      const activeWatch: ActiveWatch = {
        watcher: null,
        timer: null,
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
          cursor: cursor.id,
        });
      }, config.pollTimeout * 1000);

      // Set up fs.watch
      try {
        activeWatch.watcher = watch(fullFolder, { recursive: true }, (_eventType, filename) => {
          if (!filename || !filename.endsWith(SIDECAR_SUFFIX)) return;

          changedFiles.add(filename);

          // Debounce: wait 100ms after last change before resolving
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            complete({
              changedFiles: [...changedFiles],
              timedOut: false,
              sessionExpired: false,
              cursor: cursor.id,
            });
          }, 100);
        });

        activeWatch.watcher.on('error', () => {
          // Watcher error — resolve with empty result (will trigger re-watch or error handling upstream)
          complete({
            changedFiles: [],
            timedOut: true,
            sessionExpired: false,
            cursor: cursor.id,
          });
        });
      } catch {
        // fs.watch failed — fall back to timeout response
        cleanup();
        resolvePromise({
          changedFiles: [],
          timedOut: true,
          sessionExpired: false,
          cursor: cursor.id,
        });
      }
    });
  }

  async createCursor(folder: string, agentName: string): Promise<CursorState> {
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
      if (activeWatch.watcher) activeWatch.watcher.close();
      if (activeWatch.timer) clearTimeout(activeWatch.timer);
      if (activeWatch.resolve) {
        activeWatch.resolve({
          changedFiles: [],
          timedOut: false,
          sessionExpired: false,
          cursor: cursorId,
        });
      }
      this.activeWatches.delete(cursorId);
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
    for (const [id] of this.activeWatches) {
      this.cancel(id);
    }
    this.cursors.clear();
  }
}
