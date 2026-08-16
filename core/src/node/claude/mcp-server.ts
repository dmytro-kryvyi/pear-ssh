import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerPearTools } from './tools';
import type { ClaudeExecutor } from './executor';
import type { PermissionBridge } from './permission-bridge';

export interface PearMcpServerInfo {
  port: number;
  token: string;
  /** Full endpoint URL for .mcp.json, e.g. http://127.0.0.1:39121/mcp */
  url: string;
}

const MAX_BODY = 10 * 1024 * 1024;

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Loopback-only streamable-HTTP MCP server exposing the pear tools to a
 * `claude` CLI configured via the generated .mcp.json. Stateless: each POST
 * gets a fresh McpServer + transport (the recommended pattern for a
 * single-client local server — no session bookkeeping to leak). A random
 * bearer token per app run keeps other local processes out.
 */
export class PearMcpServer {
  private http: Server | null = null;
  private readonly token = randomBytes(24).toString('base64url');

  constructor(
    private readonly executor: ClaudeExecutor,
    /** Present in chat mode: adds the `approve` permission-prompt tool. */
    private readonly bridge?: PermissionBridge,
  ) {}

  async start(): Promise<PearMcpServerInfo> {
    if (this.http) throw new Error('MCP server already started');
    const http = createServer((req, res) => void this.handle(req, res));
    this.http = http;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = http.address();
    if (addr === null || typeof addr === 'string') throw new Error('MCP server has no port');
    return { port: addr.port, token: this.token, url: `http://127.0.0.1:${addr.port}/mcp` };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Unauthorized' },
            id: null,
          }),
        );
        return;
      }
      if (req.method !== 'POST') {
        // Stateless server: no SSE stream to GET, no session to DELETE.
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const body = await readBody(req);
      const server = new McpServer({ name: 'pear', version: '0.1.0' });
      registerPearTools(server, this.executor, this.bridge);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : 'Internal error',
            },
            id: null,
          }),
        );
      } else {
        res.end();
      }
    }
  }

  async stop(): Promise<void> {
    const http = this.http;
    if (!http) return;
    this.http = null;
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
