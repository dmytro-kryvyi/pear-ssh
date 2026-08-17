import type { PluginListenerHandle } from '@capacitor/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { registerPearTools, type ClaudeExecutor, type PermissionBridge } from '@pear/core';
import type { McpRequestEvent, PearSshPlugin } from '../pear-ssh';

/** One-shot in-memory transport: a single request in, the reply out. */
class OneShotTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly reply: (message: JSONRPCMessage) => void) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.reply(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  deliver(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

const rpcError = (message: string) =>
  JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/**
 * The WebView half of the MCP tunnel: JSON-RPC POSTs land in the Kotlin
 * relay, cross the bridge as mcpRequest events, and are served here by
 * core's registerPearTools — the exact tool surface the desktop serves,
 * running against the phone's SSH connections. Stateless per request, like
 * the desktop server: each POST gets a fresh McpServer.
 */
export class McpWebViewServer {
  private listener?: PluginListenerHandle;
  private disposed = false;

  constructor(
    private readonly plugin: PearSshPlugin,
    private readonly token: string,
    private readonly executor: ClaudeExecutor,
    private readonly bridge: PermissionBridge,
  ) {
    void plugin.addListener('mcpRequest', (e) => void this.handle(e)).then((handle) => {
      // A dispose() that raced ahead of registration still tears down.
      if (this.disposed) void handle.remove();
      else this.listener = handle;
    });
  }

  /** Stop serving — removes the bridge listener so rebuilds don't stack. */
  dispose(): void {
    this.disposed = true;
    void this.listener?.remove();
    this.listener = undefined;
  }

  private respond(id: string, status: number, body: string): void {
    void this.plugin.mcpRespond({ id, status, body });
  }

  private async handle(e: McpRequestEvent): Promise<void> {
    if (e.authorization !== `Bearer ${this.token}`) {
      this.respond(e.id, 401, rpcError('Unauthorized'));
      return;
    }
    let message: JSONRPCMessage;
    try {
      message = JSON.parse(e.body) as JSONRPCMessage;
      if (Array.isArray(message)) throw new Error('batching unsupported');
    } catch (err) {
      this.respond(e.id, 400, rpcError(err instanceof Error ? err.message : 'parse error'));
      return;
    }
    // Notifications (initialized, cancelled…) get no JSON-RPC reply.
    if (!('id' in message) || message.id === undefined || !('method' in message)) {
      this.respond(e.id, 202, '');
      return;
    }
    try {
      const server = new McpServer({ name: 'pear', version: '0.1.0' });
      registerPearTools(server, this.executor, this.bridge);
      const transport = new OneShotTransport((reply) => {
        this.respond(e.id, 200, JSON.stringify(reply));
        void server.close();
      });
      await server.connect(transport);
      transport.deliver(message);
    } catch (err) {
      this.respond(e.id, 500, rpcError(err instanceof Error ? err.message : 'internal error'));
    }
  }
}
