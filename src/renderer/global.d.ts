import type { AppApi } from '../shared/ipc';

declare global {
  interface Window {
    app: AppApi;
  }
}

export {};
