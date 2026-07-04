import { type Config, DEFAULT_CONFIG } from "../model/index.ts";

export function loadConfig(overrides: Partial<Config> = {}): Config {
	return { ...DEFAULT_CONFIG, ...overrides };
}
