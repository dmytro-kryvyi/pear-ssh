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
export {
  FACET_KINDS,
  FACET_PROVIDERS,
  detectFacets,
  fetchOrchestration,
  fetchProxmox,
  fetchStats,
  performAction,
  primaryKind,
  type BuiltAction,
  type Exec,
  type FacetProvider,
} from './orchestration/orchestration';
export {
  fetchServiceTasks,
  fetchTaskLogs,
  parseCurrentState,
  parseLogStream,
  type TaskLogsOptions,
} from './orchestration/tasks';
export {
  VITALS_COMMAND,
  VITALS_UNSUPPORTED,
  fetchVitals,
  parseVitals,
  summarizeVitals,
  type VitalsSummary,
} from './monitor/vitals';
export { fetchDockerDf } from './monitor/docker-df';
export { parseGuestIp } from './orchestration/guest-ip';
export { HostStore, sanitizeHost, type HostStorage, type SecretCipher } from './hosts/store';
export { HostGroupStore } from './hosts/groups';
export { autoShort, shortLabel } from './hosts/identity';
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
export {
  coalesceChatEvents,
  type ClaudeChatEvent,
  type ClaudeFileDiff,
  type ClaudeFocus,
  type ClaudePermissionAnswer,
  type ClaudeQuestion,
  type ClaudeQuestionOption,
  type ClaudeRevealAction,
  type ClaudeSessionMeta,
  type ClaudeTerminalInfo,
  type ClaudeUiRequest,
  type ClaudeUiRequestPayload,
  type ClaudeUiResponse,
} from './claude/events';
export { ChatStreamParser, toolDisplay } from './claude/parser';
export { applyEdit } from './claude/edit';
