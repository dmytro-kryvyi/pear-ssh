import { InjectionToken } from '@angular/core';
import type { RemoteControl } from '@pear/core';

/** Present only when the app talks to a pear-server. */
export const REMOTE = new InjectionToken<RemoteControl>('PEAR_REMOTE');
