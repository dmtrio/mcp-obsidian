import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileWatcherService } from './watcher.js';
import { WatchConfigService } from './config.js';

describe('FileWatcherService', () => {
  let vaultPath: string;
  let configService: WatchConfigService;
  let watcher: FileWatcherService;

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-test-'));
    await mkdir(join(vaultPath, 'project'), { recursive: true });

    // Use short timeouts for testing
    await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
      watch: {
        pollTimeout: 30,
        sessionTimeout: 300,
        maxConcurrent: 3,
        agents: {
          Claude: { pollTimeout: 60 }
        }
      }
    }));

    configService = new WatchConfigService(vaultPath);
    await configService.loadConfig();
    watcher = new FileWatcherService(vaultPath, configService);
  });

  afterEach(async () => {
    watcher.destroy();
    try {
      await rm(vaultPath, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ============================================================================
  // CURSOR MANAGEMENT
  // ============================================================================

  describe('cursor management', () => {
    it('creates a cursor with correct structure', () => {
      const cursor = watcher.createCursor('project', 'Claude');

      expect(cursor.id).toMatch(/^w_/);
      expect(cursor.folder).toBe('project');
      expect(cursor.agentName).toBe('Claude');
      expect(cursor.sessionStart).toBeInstanceOf(Date);
      expect(cursor.lastChecked).toBeInstanceOf(Date);
      expect(cursor.seenComments).toBeInstanceOf(Map);
      expect(cursor.seenComments.size).toBe(0);
    });

    it('decodes an existing cursor', () => {
      const cursor = watcher.createCursor('project', 'Claude');
      const decoded = watcher.decodeCursor(cursor.id);

      expect(decoded).not.toBeNull();
      expect(decoded!.id).toBe(cursor.id);
      expect(decoded!.folder).toBe('project');
    });

    it('returns null for invalid cursor', () => {
      const decoded = watcher.decodeCursor('w_nonexistent');
      expect(decoded).toBeNull();
    });

    it('updates cursor seen comments', () => {
      const cursor = watcher.createCursor('project', 'Claude');

      const seenComments = new Map([
        ['c_abc123', { replyCount: 2, status: 'open' as const, lastActivityAt: new Date().toISOString() }]
      ]);
      watcher.updateCursor(cursor.id, seenComments);

      const decoded = watcher.decodeCursor(cursor.id);
      expect(decoded!.seenComments.size).toBe(1);
      expect(decoded!.seenComments.get('c_abc123')!.replyCount).toBe(2);
    });

    it('generates unique cursor IDs', () => {
      const cursor1 = watcher.createCursor('project', 'Claude');
      const cursor2 = watcher.createCursor('project', 'Claude');
      expect(cursor1.id).not.toBe(cursor2.id);
    });
  });

  // ============================================================================
  // WATCH
  // ============================================================================

  describe('watch', () => {
    it('detects sidecar file creation', async () => {
      // Start watch, then write a sidecar file after a short delay
      const watchPromise = watcher.watch('project', undefined, 'Claude');

      // Write a sidecar file after a brief pause
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(
        join(vaultPath, 'project', 'note.md.comments.json'),
        JSON.stringify({ version: 1, comments: [] })
      );

      const result = await watchPromise;
      expect(result.timedOut).toBe(false);
      expect(result.sessionExpired).toBe(false);
      expect(result.changedFiles.length).toBeGreaterThan(0);
      expect(result.changedFiles[0]).toContain('.comments.json');
      expect(result.cursor).toMatch(/^w_/);
    });

    it('detects sidecar file modification', async () => {
      // Create sidecar first
      const sidecarPath = join(vaultPath, 'project', 'note.md.comments.json');
      await writeFile(sidecarPath, JSON.stringify({ version: 1, comments: [] }));

      // Start watch, then modify
      const watchPromise = watcher.watch('project', undefined, 'Claude');

      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(sidecarPath, JSON.stringify({ version: 1, comments: [{ id: 'c_1' }] }));

      const result = await watchPromise;
      expect(result.timedOut).toBe(false);
      expect(result.changedFiles.length).toBeGreaterThan(0);
    });

    it('ignores non-sidecar file changes', async () => {
      // Use a very short timeout config for this test
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: { pollTimeout: 30, sessionTimeout: 300 }
      }));
      const shortConfigService = new WatchConfigService(vaultPath);
      await shortConfigService.loadConfig();
      const shortWatcher = new FileWatcherService(vaultPath, shortConfigService);

      const watchPromise = shortWatcher.watch('project', undefined, 'test');

      // Write a non-sidecar file
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(join(vaultPath, 'project', 'note.md'), '# Hello');

      // Wait a bit — if the watcher incorrectly triggered on .md, it would have resolved
      await new Promise(resolve => setTimeout(resolve, 200));

      // Still active — cancel it
      shortWatcher.destroy();
      const result = await watchPromise;
      // Should have been cleaned up by destroy, not triggered by .md write
      expect(result.changedFiles).toEqual([]);
    });

    it('rejects path traversal attempts', async () => {
      await expect(watcher.watch('../../etc', undefined, 'Claude'))
        .rejects.toThrow('Folder must be within vault');
    });

    it('returns cursor for subsequent calls', async () => {
      const watchPromise = watcher.watch('project', undefined, 'Claude');

      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(
        join(vaultPath, 'project', 'note.md.comments.json'),
        JSON.stringify({ version: 1, comments: [] })
      );

      const result = await watchPromise;
      const cursor = result.cursor;

      // Use cursor for second watch
      const watch2Promise = watcher.watch('project', cursor, 'Claude');

      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(
        join(vaultPath, 'project', 'note.md.comments.json'),
        JSON.stringify({ version: 1, comments: [{ id: 'c_new' }] })
      );

      const result2 = await watch2Promise;
      expect(result2.cursor).toBe(cursor);
      expect(result2.changedFiles.length).toBeGreaterThan(0);
    });

    it('treats invalid cursor as first call', async () => {
      const watchPromise = watcher.watch('project', 'w_bogus', 'Claude');

      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(
        join(vaultPath, 'project', 'note.md.comments.json'),
        JSON.stringify({ version: 1, comments: [] })
      );

      const result = await watchPromise;
      expect(result.timedOut).toBe(false);
      // New cursor was created
      expect(result.cursor).toMatch(/^w_/);
      expect(result.cursor).not.toBe('w_bogus');
    });
  });

  // ============================================================================
  // SESSION EXPIRY
  // ============================================================================

  describe('session expiry', () => {
    it('returns session_expired when session timeout exceeded', async () => {
      // Create a cursor with an old session start
      const cursor = watcher.createCursor('project', 'Claude');
      cursor.sessionStart = new Date(Date.now() - 400 * 1000); // 400s ago, timeout is 300s

      const result = await watcher.watch('project', cursor.id, 'Claude');
      expect(result.sessionExpired).toBe(true);
      expect(result.changedFiles).toEqual([]);
    });

    it('cleanupExpiredSessions removes old cursors', () => {
      const cursor1 = watcher.createCursor('project', 'Claude');
      cursor1.sessionStart = new Date(Date.now() - 4000 * 1000); // very old

      const cursor2 = watcher.createCursor('project', 'Claude');
      // cursor2 is fresh

      const cleaned = watcher.cleanupExpiredSessions(3600);
      expect(cleaned).toBe(1);
      expect(watcher.decodeCursor(cursor1.id)).toBeNull();
      expect(watcher.decodeCursor(cursor2.id)).not.toBeNull();
    });
  });

  // ============================================================================
  // CONCURRENT WATCHES
  // ============================================================================

  describe('concurrent watches', () => {
    it('enforces max concurrent watch limit', async () => {
      // Config has maxConcurrent: 3
      // Start 3 watches (they'll block on poll timeout)
      const p1 = watcher.watch('project', undefined, 'Agent1');
      const p2 = watcher.watch('project', undefined, 'Agent2');
      const p3 = watcher.watch('project', undefined, 'Agent3');

      // Wait for watches to register
      await new Promise(resolve => setTimeout(resolve, 50));

      // 4th should fail
      await expect(watcher.watch('project', undefined, 'Agent4'))
        .rejects.toThrow('Maximum concurrent watches reached (3)');

      // Clean up
      watcher.destroy();
      await Promise.allSettled([p1, p2, p3]);
    });

    it('tracks active watch count', async () => {
      expect(watcher.getActiveWatchCount()).toBe(0);

      const p1 = watcher.watch('project', undefined, 'Claude');
      // Small delay to let watch set up
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(watcher.getActiveWatchCount()).toBe(1);

      watcher.destroy();
      await Promise.allSettled([p1]);
      expect(watcher.getActiveWatchCount()).toBe(0);
    });
  });

  // ============================================================================
  // CANCEL
  // ============================================================================

  describe('cancel', () => {
    it('cancels an active watch', async () => {
      // Create cursor first to get the ID, then watch with it
      const cursor = watcher.createCursor('project', 'Claude');
      const watchPromise = watcher.watch('project', cursor.id, 'Claude');

      // Small delay to let watch set up
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(watcher.getActiveWatchCount()).toBe(1);

      watcher.cancel(cursor.id);

      const result = await watchPromise;
      expect(result.timedOut).toBe(false);
      expect(result.changedFiles).toEqual([]);
      expect(watcher.getActiveWatchCount()).toBe(0);
    });
  });

  // ============================================================================
  // DEBOUNCING
  // ============================================================================

  describe('debouncing', () => {
    it('collects rapid changes into single result', async () => {
      const watchPromise = watcher.watch('project', undefined, 'Claude');

      await new Promise(resolve => setTimeout(resolve, 50));

      // Write multiple sidecar files rapidly
      await writeFile(
        join(vaultPath, 'project', 'note1.md.comments.json'),
        JSON.stringify({ version: 1, comments: [] })
      );
      await writeFile(
        join(vaultPath, 'project', 'note2.md.comments.json'),
        JSON.stringify({ version: 1, comments: [] })
      );

      const result = await watchPromise;
      expect(result.timedOut).toBe(false);
      // Should have collected at least one of the changes
      expect(result.changedFiles.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // DESTROY
  // ============================================================================

  describe('destroy', () => {
    it('cleans up all watchers and cursors', async () => {
      const p1 = watcher.watch('project', undefined, 'Claude');
      await new Promise(resolve => setTimeout(resolve, 10));

      watcher.destroy();
      await Promise.allSettled([p1]);

      expect(watcher.getActiveWatchCount()).toBe(0);
      // All cursors cleared
      expect(watcher.decodeCursor('anything')).toBeNull();
    });
  });
});
