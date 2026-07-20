// Platform-pure entry point: no `node:*`, no ssh2. Importable from a browser
// or WebView. Node-only implementations live in `@pear/core/node`.
export * from './types';
export type { PearApi } from './api';
export type {
  AbortSignalLike,
  ExecResult,
  ShellChannel,
  SshTransport,
  SshTransportFactory,
  TransferOpts,
  TransferProgress,
} from './ssh/transport';
export {
  TransferEngine,
  joinPath,
  type ConflictPolicy,
  type TransferEndpoint,
  type TransferEnv,
  type TransferEvents,
  type TransferJobSnapshot,
  type TransferOp,
  type TransferRequest,
  type TransferStatus,
} from './transfers/engine';
export { SessionManager, type TerminalHandle } from './ssh/sessions';
export { kindOf, modeString } from './ssh/mode';
export {
  SubHostTransport,
  parseStatListing,
  probeCommand,
  probeError,
  subExec,
  subShellCommand,
} from './ssh/subhost';
export { primaryKind } from './orchestration/orchestration';
export { parseGuestIp } from './orchestration/guest-ip';
export { HostStore, type HostStorage } from './hosts/store';
export { EphemeralHostRegistry } from './hosts/ephemeral';
export { shq } from './shq';
export {
  HistoryStore,
  bestSuggestion,
  looksSensitive,
  normalizeCommand,
  rankSuggestions,
  type HistoryEntry,
  type HistoryStorage,
} from './history/store';
export {
  HISTORY_FILES,
  importShellHistory,
  parseHistoryFile,
  type ImportResult,
} from './history/import';
export { uuid } from './uuid';
