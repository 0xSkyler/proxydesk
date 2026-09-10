import type { AppApi } from '../shared/types/ipc';

declare global {
  interface Window {
    app: AppApi;
  }
}

export {};
