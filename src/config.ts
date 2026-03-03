import { readFile } from 'node:fs/promises';
import { join, resolve } from 'path';
import type { WatchConfig, ResolvedWatchConfig, AgentWatchConfig } from './types.js';

const CONFIG_FILENAME = '.mcp-obsidian.json';

const DEFAULTS: WatchConfig = {
  pollTimeout: 300,
  sessionTimeout: 3600,
  maxConcurrent: 5,
  agents: {},
};

const LIMITS = {
  pollTimeout: { min: 30, max: 900 },
  sessionTimeout: { min: 300, max: 86400 },
  maxConcurrent: { min: 1, max: 20 },
} as const;

export interface CliWatchArgs {
  pollTimeout?: number;
  sessionTimeout?: number;
}

export class WatchConfigService {
  private config: WatchConfig;

  constructor(
    private vaultPath: string,
    private cliArgs: CliWatchArgs = {}
  ) {
    this.vaultPath = resolve(vaultPath);
    this.config = { ...DEFAULTS, agents: {} };
  }

  async loadConfig(): Promise<WatchConfig> {
    let fileConfig: Partial<{ watch: Partial<WatchConfig> }> = {};

    try {
      const configPath = join(this.vaultPath, CONFIG_FILENAME);
      const content = await readFile(configPath, 'utf-8');
      fileConfig = JSON.parse(content);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        // No config file — use defaults
      } else if (error instanceof SyntaxError) {
        console.warn(`Failed to parse ${CONFIG_FILENAME}: ${error.message}. Using defaults.`);
      } else {
        console.warn(`Failed to read ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : 'Unknown error'}. Using defaults.`);
      }
    }

    const watchSection = fileConfig.watch || {};

    this.config = {
      pollTimeout: this.validateNumber(
        this.cliArgs.pollTimeout ?? watchSection.pollTimeout ?? DEFAULTS.pollTimeout,
        LIMITS.pollTimeout,
        'pollTimeout',
        DEFAULTS.pollTimeout
      ),
      sessionTimeout: this.validateNumber(
        this.cliArgs.sessionTimeout ?? watchSection.sessionTimeout ?? DEFAULTS.sessionTimeout,
        LIMITS.sessionTimeout,
        'sessionTimeout',
        DEFAULTS.sessionTimeout
      ),
      maxConcurrent: this.validateNumber(
        watchSection.maxConcurrent ?? DEFAULTS.maxConcurrent,
        LIMITS.maxConcurrent,
        'maxConcurrent',
        DEFAULTS.maxConcurrent
      ),
      agents: this.validateAgents(watchSection.agents || {}),
    };

    // Ensure sessionTimeout > pollTimeout
    if (this.config.sessionTimeout <= this.config.pollTimeout) {
      console.warn(`sessionTimeout (${this.config.sessionTimeout}) must be greater than pollTimeout (${this.config.pollTimeout}). Using defaults.`);
      this.config.pollTimeout = DEFAULTS.pollTimeout;
      this.config.sessionTimeout = DEFAULTS.sessionTimeout;
    }

    return this.config;
  }

  resolveForAgent(agentName?: string): ResolvedWatchConfig {
    const agentConfig = agentName ? this.config.agents[agentName] : undefined;

    let pollTimeout = agentConfig?.pollTimeout ?? this.config.pollTimeout;
    let sessionTimeout = agentConfig?.sessionTimeout ?? this.config.sessionTimeout;

    // Validate agent overrides
    pollTimeout = this.validateNumber(pollTimeout, LIMITS.pollTimeout, 'pollTimeout', this.config.pollTimeout);
    sessionTimeout = this.validateNumber(sessionTimeout, LIMITS.sessionTimeout, 'sessionTimeout', this.config.sessionTimeout);

    if (sessionTimeout <= pollTimeout) {
      pollTimeout = this.config.pollTimeout;
      sessionTimeout = this.config.sessionTimeout;
    }

    return {
      pollTimeout,
      sessionTimeout,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  getConfig(): WatchConfig {
    return { ...this.config, agents: { ...this.config.agents } };
  }

  private validateNumber(
    value: unknown,
    limits: { min: number; max: number },
    fieldName: string,
    fallback: number
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (value !== undefined) {
        console.warn(`Invalid ${fieldName}: ${value}. Using default ${fallback}.`);
      }
      return fallback;
    }
    if (value < limits.min || value > limits.max) {
      console.warn(`${fieldName} ${value} out of range (${limits.min}-${limits.max}). Using default ${fallback}.`);
      return fallback;
    }
    if (fieldName === 'maxConcurrent' && !Number.isInteger(value)) {
      console.warn(`${fieldName} must be an integer. Using default ${fallback}.`);
      return fallback;
    }
    return value;
  }

  private validateAgents(agents: unknown): Record<string, AgentWatchConfig> {
    if (!agents || typeof agents !== 'object') {
      return {};
    }

    const result: Record<string, AgentWatchConfig> = {};
    for (const [name, config] of Object.entries(agents as Record<string, unknown>)) {
      if (!name || typeof name !== 'string') continue;
      if (!config || typeof config !== 'object') continue;

      const agentConfig = config as Partial<AgentWatchConfig>;
      result[name] = {};

      if (agentConfig.pollTimeout !== undefined) {
        result[name].pollTimeout = agentConfig.pollTimeout;
      }
      if (agentConfig.sessionTimeout !== undefined) {
        result[name].sessionTimeout = agentConfig.sessionTimeout;
      }
    }
    return result;
  }
}
