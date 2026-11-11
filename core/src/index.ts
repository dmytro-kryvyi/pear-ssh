// Platform-pure entry point: no `node:*`, no ssh2. Importable from a browser
// or WebView. Node-only implementations live in `@pear/core/node`.
export * from './types';
export type { PearApi } from './api';
export type {
  AbortSignalLike,
  ExecOptions,
  ExecResult,
  PipeChannel,
  ShellChannel,
  SshTransport,
  SshTransportFactory,
  TransferLegPhase,
  TransferOpts,
  TransferProgress,
} from './ssh/transport';
export {
  TransferEngine,
  joinPath,
  type ConflictPolicy,
  type TarIo,
  type TarPackInput,
  type TarPackOpts,
  type TarUnpackOpts,
  type TransferEndpoint,
  type TransferEnv,
  type TransferEvents,
  type TransferJobSnapshot,
  type TransferOp,
  type TransferPhase,
  type TransferRequest,
  type TransferStatus,
} from './transfers/engine';
export {
  ACTION_EXEC_TIMEOUT_MS,
  POLL_EXEC_TIMEOUT_MS,
  SessionManager,
  type TerminalHandle,
} from './ssh/sessions';
export { ExecTimeoutError, describeChannelOpenError } from './ssh/exec-errors';
export {
  PASSTHROUGH_POLICY,
  TerminalHub,
  type TermHubEvents,
  type TermInfo,
  type TermOps,
  type TermPolicy,
  type TermRead,
} from './ssh/term-hub';
export {
  PearDisconnectedError,
  createRemoteBackend,
  type RemoteBackend,
  type RemoteBackendOpts,
  type RemoteControl,
  type RemoteHello,
  type RemoteState,
  type RemoteUpdate,
  type WebSocketLike,
} from './remote/client';
export {
  CHANNELS,
  buildApiClient,
  channelsOf,
  type ApiClientTransport,
  type ChannelKind,
  type ChannelRow,
  type ChannelTable,
} from './rpc/channels';
export { kindOf, modeString, modeText, octalOf, parseOctal } from './ssh/mode';
export * from './fs';
export {
  HostKeyError,
  KnownHosts,
  type HostKeyErrorCode,
  type HostKeyGate,
  type HostKeyPrompt,
  type KnownHostsStorage,
} from './ssh/known-hosts';
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
export {
  resolveSshHosts,
  tokenizeSshConfig,
  type SshConfigDirective,
  type SshConfigEntry,
} from './hosts/ssh-config';
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
  type ClaudeChatState,
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
export {
  ClaudeExecutor,
  utf8ByteLength,
  type ClaudeExecutorEnv,
  type ClaudeHostInfo,
  type RunResult,
} from './claude/executor';
export { PermissionBridge, type PermissionAnswer } from './claude/permission-bridge';
export { registerPearTools, truncateOutput } from './claude/tools';
export {
  ClaudeChatRuntime,
  type ChatIndexStorage,
  type ChatRuntimeOpts,
  type ChatSessionFactory,
  type ChatSessionHandle,
  type ChatTranscriptStore,
} from './claude/chat-runtime';
