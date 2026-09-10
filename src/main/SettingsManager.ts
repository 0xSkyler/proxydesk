import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types/settings';
import type { StorageManager } from './StorageManager';
import { logger } from './Logger';

const SETTINGS_KEY = 'settings';

export class SettingsManager {
  private settings: AppSettings = DEFAULT_SETTINGS;
  private listeners = new Set<(settings: AppSettings) => void>();

  constructor(private readonly storage: StorageManager) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<Partial<AppSettings>>(SETTINGS_KEY, {});
    this.settings = mergeSettings(DEFAULT_SETTINGS, stored);
    logger.info('application', 'Settings loaded.');
  }

  get(): AppSettings {
    return this.settings;
  }

  async update(partial: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = mergeSettings(this.settings, partial);
    await this.storage.write(SETTINGS_KEY, this.settings);
    this.notify();
    return this.settings;
  }

  async reset(): Promise<AppSettings> {
    this.settings = DEFAULT_SETTINGS;
    await this.storage.write(SETTINGS_KEY, this.settings);
    this.notify();
    return this.settings;
  }

  onChange(cb: (settings: AppSettings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb(this.settings);
  }
}

function mergeSettings(base: AppSettings, partial: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...partial,
    browser: { ...base.browser, ...partial.browser },
    proxy: { ...base.proxy, ...partial.proxy },
    performance: { ...base.performance, ...partial.performance },
    application: { ...base.application, ...partial.application },
    customProviders: partial.customProviders ?? base.customProviders
  };
}
