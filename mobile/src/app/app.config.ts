import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideStubBackend } from './backend';

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideStubBackend()],
};
