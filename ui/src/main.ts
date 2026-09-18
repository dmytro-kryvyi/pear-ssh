import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { connectToPearServer, servedByPearServer } from './app/remote/connect';

// Electron's preload has already put the bridge on window.pear. Served by a
// pear-server instead (the PWA), the same surface comes over a WebSocket —
// installed here, before bootstrap, so nothing above it can tell the difference.
if (!window.pear && servedByPearServer()) window.pear = connectToPearServer();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
