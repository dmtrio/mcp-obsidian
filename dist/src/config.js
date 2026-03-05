import { readFile } from 'node:fs/promises';
import { join, resolve } from 'path';
const CONFIG_FILENAME = '.mcp-obsidian.json';
const DEFAULTS = {
    pollTimeout: 300,
    sessionTimeout: 3600,
    maxConcurrent: 5,
    agents: {},
};
const LIMITS = {
    pollTimeout: { min: 30, max: 900 },
    sessionTimeout: { min: 300, max: 86400 },
    maxConcurrent: { min: 1, max: 20 },
};
export class WatchConfigService {
    vaultPath;
    cliArgs;
    config;
    constructor(vaultPath, cliArgs = {}) {
        this.vaultPath = vaultPath;
        this.cliArgs = cliArgs;
        this.vaultPath = resolve(vaultPath);
        this.config = { ...DEFAULTS, agents: {} };
    }
    async loadConfig() {
        let fileConfig = {};
        try {
            const configPath = join(this.vaultPath, CONFIG_FILENAME);
            const content = await readFile(configPath, 'utf-8');
            fileConfig = JSON.parse(content);
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                // No config file — use defaults
            }
            else if (error instanceof SyntaxError) {
                console.warn(`Failed to parse ${CONFIG_FILENAME}: ${error.message}. Using defaults.`);
            }
            else {
                console.warn(`Failed to read ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : 'Unknown error'}. Using defaults.`);
            }
        }
        const watchSection = fileConfig.watch || {};
        this.config = {
            pollTimeout: this.validateNumber(this.cliArgs.pollTimeout ?? watchSection.pollTimeout ?? DEFAULTS.pollTimeout, LIMITS.pollTimeout, 'pollTimeout', DEFAULTS.pollTimeout),
            sessionTimeout: this.validateNumber(this.cliArgs.sessionTimeout ?? watchSection.sessionTimeout ?? DEFAULTS.sessionTimeout, LIMITS.sessionTimeout, 'sessionTimeout', DEFAULTS.sessionTimeout),
            maxConcurrent: this.validateNumber(watchSection.maxConcurrent ?? DEFAULTS.maxConcurrent, LIMITS.maxConcurrent, 'maxConcurrent', DEFAULTS.maxConcurrent),
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
    resolveForAgent(agentName) {
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
    getConfig() {
        return { ...this.config, agents: { ...this.config.agents } };
    }
    validateNumber(value, limits, fieldName, fallback) {
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
    validateAgents(agents) {
        if (!agents || typeof agents !== 'object') {
            return {};
        }
        const result = {};
        for (const [name, config] of Object.entries(agents)) {
            if (!name || typeof name !== 'string')
                continue;
            if (!config || typeof config !== 'object')
                continue;
            const agentConfig = config;
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
