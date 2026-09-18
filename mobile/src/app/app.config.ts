import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { provideMockBackend } from './mock/mock-backend';
import { provideNativeBackend } from './native/provide';
import { servedByPearServer } from './remote/connect';
import { provideRemoteBackend } from './remote/provide';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Real SSH on device; a pear-server when one served this page (the PWA);
    // otherwise the seeded in-memory mock (plain `ng serve` in a browser).
    Capacitor.isNativePlatform()
      ? provideNativeBackend()
      : servedByPearServer()
        ? provideRemoteBackend()
        : provideMockBackend(),
  ],
};
