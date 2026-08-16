// Node-only entry point (`@pear/core/node`): ssh2 and fs-backed
// implementations of the interfaces exported from `@pear/core`.
export { SshConnection } from './connection';
export { LocalConnection } from './local';
export { JsonFileStorage } from './json-storage';
export { makeStagingDir, removeStaging, sweepStaging } from './staging';
export { PortForwardManager, type PortForwardInfo } from './port-forward';
export {
  ClaudeExecutor,
  type ClaudeExecutorEnv,
  type ClaudeHostInfo,
  type RunResult,
} from './claude/executor';
export { PearMcpServer, type PearMcpServerInfo } from './claude/mcp-server';
export { claudeInstalled, launchClaudePty } from './claude/pty';
export { ClaudeChatSession, type ChatSessionOpts } from './claude/chat-session';
export { PermissionBridge, type PermissionAnswer } from './claude/permission-bridge';
export {
  ClaudeChatRuntime,
  type ChatIndexStorage,
  type ChatRuntimeOpts,
} from './claude/chat-runtime';
export { provisionClaudeWorkspace, type ClaudeWorkspaceConfig } from './claude/workspace';
