// Node-only entry point (`@pear/core/node`): ssh2 and fs-backed
// implementations of the interfaces exported from `@pear/core`.
export { SshConnection } from './connection';
export { LocalConnection } from './local';
export { JsonFileStorage } from './json-storage';
export { makeStagingDir, removeStaging, sweepStaging } from './staging';
