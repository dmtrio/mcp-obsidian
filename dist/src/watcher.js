import chokidar, {} from 'chokidar';
import { resolve } from 'path';
import { WatchConfigService } from './config.js';
const SIDECAR_SUFFIX = '.comments.json';
const CLEANUP_INTERVAL_MS = 60_000;
export class FileWatcherService {
    configService;
    vaultPath;
    cursors = new Map();
    activeWatches = new Map();
    cursorCounter = 0;
    cleanupInterval;
    constructor(vaultPath, configService) {
        this.configService = configService;
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
    validateFolder(folder) {
        const fullFolder = resolve(this.vaultPath, folder);
        if (!fullFolder.startsWith(this.vaultPath + '/') && fullFolder !== this.vaultPath) {
            throw new Error(`Folder must be within vault: ${folder}`);
        }
        return fullFolder;
    }
    async watch(folder, cursorId, agentName) {
        const config = this.configService.resolveForAgent(agentName);
        // Validate folder is within vault
        const fullFolder = this.validateFolder(folder);
        // Check max concurrent
        if (this.activeWatches.size >= config.maxConcurrent) {
            throw new Error(`Maximum concurrent watches reached (${config.maxConcurrent})`);
        }
        // Resolve or create cursor
        let cursor;
        if (cursorId) {
            const existing = this.decodeCursor(cursorId);
            if (!existing) {
                // Invalid/expired cursor — create fresh
                cursor = this.createCursor(folder, agentName || 'unknown');
            }
            else {
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
        }
        else {
            cursor = this.createCursor(folder, agentName || 'unknown');
        }
        return new Promise((resolvePromise) => {
            let resolved = false;
            const changedFiles = new Set();
            const cleanup = () => {
                if (activeWatch.watcher) {
                    activeWatch.watcher.close().catch(() => { });
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
            const complete = (result) => {
                if (resolved)
                    return; // Guard against double-resolve
                resolved = true;
                cleanup();
                cursor.lastChecked = new Date();
                resolvePromise(result);
            };
            const activeWatch = {
                watcher: null,
                timer: null,
                debounceTimer: null,
                resolve: resolvePromise,
                cursorId: cursor.id,
            };
            this.activeWatches.set(cursor.id, activeWatch);
            // Set up chokidar watcher — works cross-platform (macOS, Windows, Linux)
            activeWatch.watcher = chokidar.watch('.', {
                cwd: fullFolder,
                ignoreInitial: true,
            });
            activeWatch.watcher.on('all', (_event, filePath) => {
                if (!filePath.endsWith(SIDECAR_SUFFIX))
                    return;
                changedFiles.add(filePath);
                // Debounce: wait 100ms after last change before resolving
                if (activeWatch.debounceTimer)
                    clearTimeout(activeWatch.debounceTimer);
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
            // Start timeout only after chokidar is ready (initial scan complete)
            activeWatch.watcher.on('ready', () => {
                activeWatch.timer = setTimeout(() => {
                    complete({
                        changedFiles: [],
                        timedOut: true,
                        sessionExpired: false,
                        watchError: false,
                        cursor: cursor.id,
                    });
                }, config.pollTimeout * 1000);
            });
        });
    }
    createCursor(folder, agentName) {
        const id = 'w_' + (++this.cursorCounter).toString(36) + '_' + Date.now().toString(36);
        const now = new Date();
        const cursor = {
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
    decodeCursor(cursorId) {
        return this.cursors.get(cursorId) || null;
    }
    updateCursor(cursorId, seenComments) {
        const cursor = this.cursors.get(cursorId);
        if (cursor) {
            cursor.seenComments = seenComments;
            cursor.lastChecked = new Date();
        }
    }
    cancel(cursorId) {
        const activeWatch = this.activeWatches.get(cursorId);
        if (activeWatch) {
            if (activeWatch.watcher) {
                activeWatch.watcher.close().catch(() => { });
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
    getActiveWatchCount() {
        return this.activeWatches.size;
    }
    /**
     * Wait for a specific watch to become ready (chokidar initial scan complete).
     * Useful for testing. Returns false if cursor not found or no active watch.
     */
    waitForReady(cursorId) {
        const activeWatch = this.activeWatches.get(cursorId);
        if (!activeWatch?.watcher)
            return Promise.resolve(false);
        return new Promise((resolve) => {
            // If timer is already set, ready has already fired
            if (activeWatch.timer) {
                resolve(true);
                return;
            }
            activeWatch.watcher.on('ready', () => resolve(true));
        });
    }
    cleanupExpiredSessions(maxSessionTimeout) {
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
    destroy() {
        clearInterval(this.cleanupInterval);
        // Collect IDs first — cancel() mutates activeWatches
        const ids = [...this.activeWatches.keys()];
        for (const id of ids) {
            this.cancel(id);
        }
        this.cursors.clear();
    }
}
