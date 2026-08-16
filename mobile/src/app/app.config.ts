import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { provideMockBackend } from './mock/mock-backend';
import { provideNativeBackend } from './native/provide';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Real SSH on device; the seeded in-memory mock in a desktop browser.
    Capacitor.isNativePlatform() ? provideNativeBackend() : provideMockBackend(),
  ],
};
