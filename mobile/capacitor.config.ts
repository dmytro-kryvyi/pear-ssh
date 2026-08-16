import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.pear.mobile',
  appName: 'Pear',
  webDir: 'dist/mobile/browser',
  // Debug builds log every bridge call+event to Logcat/devtools; with
  // per-frame shellData events that logging throttles PTY throughput by
  // orders of magnitude. Terminal streams need it off.
  loggingBehavior: 'none',
};

export default config;
