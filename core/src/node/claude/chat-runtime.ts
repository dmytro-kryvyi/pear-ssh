import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeChatRuntime as PureChatRuntime,
  type ChatIndexStorage,
} from '../../claude/chat-runtime';
import type { ClaudeExecutor } from '../../claude/executor';
import type { ClaudeChatEvent } from '../../claude/events';
import { ClaudeChatSession } from './chat-session';

export type { ChatIndexStorage } from '../../claude/chat-runtime';

export interface ChatRuntimeOpts {
  /** Provisioned workspace dir (cwd for the CLI; transcripts live under it). */
  dir: string;
  /** Session index storage (JsonFileStorage → claude-sessions.json). */
  storage: ChatIndexStorage;
  /** Push one event to the renderer. */
  emit: (e: ClaudeChatEvent) => void;
  /** For diff previews on write_file permission cards. */
  executor?: ClaudeExecutor;
}

/**
 * Desktop binding of the pure ClaudeChatRuntime: transcripts as files under
 * the workspace dir, sessions as local `claude` child processes. Same
 * constructor contract as before the runtime moved to the pure layer.
 */
export class ClaudeChatRuntime extends PureChatRuntime {
  constructor(opts: ChatRuntimeOpts) {
    const transcriptPath = (id: string) => join(opts.dir, 'transcripts', `${id}.json`);
    super({
      storage: opts.storage,
      emit: opts.emit,
      executor: opts.executor,
      transcripts: {
        read: (id) => {
          try {
            return readFileSync(transcriptPath(id), 'utf8');
          } catch {
            return null;
          }
        },
        write: (id, data) => {
          mkdirSync(join(opts.dir, 'transcripts'), { recursive: true });
          writeFileSync(transcriptPath(id), data);
        },
      },
      createSession: (o, onEvent) =>
        new ClaudeChatSession({ dir: opts.dir, resume: o.resume, model: o.model }, onEvent),
    });
  }
}
