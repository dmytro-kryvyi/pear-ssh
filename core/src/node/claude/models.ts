import { spawn } from 'node:child_process';
import { listModelsRequest, parseModelList, type ClaudeModelInfo } from '../../claude/models';
import { uuid } from '../../uuid';
import { loginShell } from './shell';

const TIMEOUT_MS = 8_000;

/**
 * Ask the installed claude CLI which models it offers. Spawns a throwaway
 * `claude -p` in stream-json mode (no MCP servers, so it starts fast), sends
 * one `list_models` control request, and kills the process as soon as the
 * matching reply arrives. Rejects on timeout or CLI error.
 */
export function listClaudeModels(): Promise<ClaudeModelInfo[]> {
  const requestId = uuid();
  const { file, commandArgs } = loginShell();
  const command =
    "claude -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --mcp-config '{\"mcpServers\":{}}'";
  return new Promise((resolve, reject) => {
    const child = spawn(file, commandArgs(command), { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('claude did not answer list_models in time'))),
      TIMEOUT_MS,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          const models = parseModelList(msg, requestId);
          if (models) finish(() => resolve(models));
        } catch (err) {
          finish(() => reject(err));
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2048);
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) =>
      finish(() =>
        reject(new Error(`claude exited (${code}) before listing models${stderr ? ` — ${stderr.trim()}` : ''}`)),
      ),
    );
    child.stdin!.write(listModelsRequest(requestId));
  });
}
