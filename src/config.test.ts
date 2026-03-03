import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { WatchConfigService } from './config.js';

describe('WatchConfigService', () => {
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'mcp-config-test-'));
  });

  afterEach(async () => {
    try {
      await rm(vaultPath, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  // ============================================================================
  // CONFIG LOADING
  // ============================================================================

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', async () => {
      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.pollTimeout).toBe(300);
      expect(config.sessionTimeout).toBe(3600);
      expect(config.maxConcurrent).toBe(5);
      expect(config.agents).toEqual({});
    });

    it('loads valid config from JSON file', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: {
          pollTimeout: 120,
          sessionTimeout: 7200,
          maxConcurrent: 3,
          agents: {
            Claude: { pollTimeout: 600, sessionTimeout: 10800 }
          }
        }
      }));

      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.pollTimeout).toBe(120);
      expect(config.sessionTimeout).toBe(7200);
      expect(config.maxConcurrent).toBe(3);
      expect(config.agents.Claude).toEqual({ pollTimeout: 600, sessionTimeout: 10800 });
    });

    it('falls back to defaults on malformed JSON', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), 'not valid json {{{');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.pollTimeout).toBe(300);
      expect(config.sessionTimeout).toBe(3600);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
    });

    it('CLI overrides take precedence over JSON defaults', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: { pollTimeout: 120, sessionTimeout: 7200 }
      }));

      const service = new WatchConfigService(vaultPath, { pollTimeout: 60 });
      const config = await service.loadConfig();

      expect(config.pollTimeout).toBe(60);
      // sessionTimeout from file
      expect(config.sessionTimeout).toBe(7200);
    });

    it('falls back on pollTimeout out of range', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: { pollTimeout: 5, sessionTimeout: 3600 }
      }));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.pollTimeout).toBe(300);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('out of range'));
    });

    it('falls back on sessionTimeout out of range (too high)', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: { sessionTimeout: 100000 }
      }));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.sessionTimeout).toBe(3600);
    });

    it('falls back when sessionTimeout <= pollTimeout', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: { pollTimeout: 600, sessionTimeout: 600 }
      }));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.pollTimeout).toBe(300);
      expect(config.sessionTimeout).toBe(3600);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('must be greater than'));
    });

    it('falls back on non-integer maxConcurrent', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: { maxConcurrent: 3.5 }
      }));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.maxConcurrent).toBe(5);
    });

    it('ignores unknown keys (forward compatibility)', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: { pollTimeout: 120, sessionTimeout: 3600, futureFeature: true },
        search: { maxResults: 50 }
      }));

      const service = new WatchConfigService(vaultPath);
      const config = await service.loadConfig();

      expect(config.pollTimeout).toBe(120);
      // No error thrown for unknown keys
    });
  });

  // ============================================================================
  // PER-AGENT RESOLUTION
  // ============================================================================

  describe('resolveForAgent', () => {
    it('returns defaults for unknown agent', async () => {
      const service = new WatchConfigService(vaultPath);
      await service.loadConfig();

      const resolved = service.resolveForAgent('UnknownAgent');
      expect(resolved.pollTimeout).toBe(300);
      expect(resolved.sessionTimeout).toBe(3600);
      expect(resolved.maxConcurrent).toBe(5);
    });

    it('returns agent-specific overrides', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: {
          pollTimeout: 300,
          sessionTimeout: 3600,
          agents: {
            Claude: { pollTimeout: 600, sessionTimeout: 7200 }
          }
        }
      }));

      const service = new WatchConfigService(vaultPath);
      await service.loadConfig();

      const resolved = service.resolveForAgent('Claude');
      expect(resolved.pollTimeout).toBe(600);
      expect(resolved.sessionTimeout).toBe(7200);
    });

    it('inherits unset fields from defaults', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: {
          pollTimeout: 120,
          sessionTimeout: 7200,
          agents: {
            Claude: { pollTimeout: 600 }
          }
        }
      }));

      const service = new WatchConfigService(vaultPath);
      await service.loadConfig();

      const resolved = service.resolveForAgent('Claude');
      expect(resolved.pollTimeout).toBe(600);
      // sessionTimeout inherited from top-level
      expect(resolved.sessionTimeout).toBe(7200);
    });

    it('returns defaults when no agent name provided', async () => {
      const service = new WatchConfigService(vaultPath);
      await service.loadConfig();

      const resolved = service.resolveForAgent();
      expect(resolved.pollTimeout).toBe(300);
      expect(resolved.sessionTimeout).toBe(3600);
    });

    it('falls back when agent-specific values create invalid combination', async () => {
      await writeFile(join(vaultPath, '.mcp-obsidian.json'), JSON.stringify({
        watch: {
          pollTimeout: 300,
          sessionTimeout: 3600,
          agents: {
            BadAgent: { pollTimeout: 800, sessionTimeout: 400 }
          }
        }
      }));

      const service = new WatchConfigService(vaultPath);
      await service.loadConfig();

      const resolved = service.resolveForAgent('BadAgent');
      // Falls back because sessionTimeout <= pollTimeout
      expect(resolved.pollTimeout).toBe(300);
      expect(resolved.sessionTimeout).toBe(3600);
    });
  });
});
