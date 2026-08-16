import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { PearSsh, benchPty } from './app/native/pear-ssh';

// Dev hook for the M2 bridge spike: lets a chrome://inspect console drive the
// native plugin directly (connect → benchPty) before M3 wires it into the
// backend. No-ops on web where the plugin is unimplemented.
(window as { pearSsh?: unknown }).pearSsh = { PearSsh, benchPty };

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
