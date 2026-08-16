import { createServer, type Server, type Socket } from 'node:net';
import type { HostConfig } from '../types';
import type { SshTransport } from '../ssh/transport';
import { uuid } from '../uuid';
import { SshConnection } from './connection';

export interface PortForwardInfo {
  id: string;
  hostId: string;
  hostName: string;
  /** Destination as seen from the remote host (usually 127.0.0.1). */
  remoteHost: string;
  remotePort: number;
  localHost: '127.0.0.1';
  localPort: number;
  startedAt: number;
}

interface ActiveForward {
  info: PortForwardInfo;
  server: Server;
  sockets: Set<Socket>;
}

/**
 * Local port forwards over the app's SSH connections: a loopback TCP listener
 * per forward, each accepted socket piped into an ssh2 forwardOut channel.
 * Node-layer only — forwarding needs a direct ssh2 client, so local hosts and
 * sub-hosts (docker/pct exec tunnels) are rejected with a clear error.
 */
export class PortForwardManager {
  private readonly forwards = new Map<string, ActiveForward>();

  constructor(private readonly getTransport: (host: HostConfig) => Promise<SshTransport>) {}

  async open(
    host: HostConfig,
    remotePort: number,
    remoteHost = '127.0.0.1',
    localPort = 0,
  ): Promise<PortForwardInfo> {
    const transport = await this.getTransport(host);
    if (!(transport instanceof SshConnection)) {
      throw new Error(
        `port forwarding needs a direct SSH connection — '${host.name}' is a ` +
          (host.local ? 'local host' : 'sub-host (docker/pct exec)'),
      );
    }
    // Eager probe: a refused remote port should fail this call, not silently
    // kill every future local connection.
    (await transport.forwardOut(remoteHost, remotePort)).destroy();

    const server = createServer();
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      transport.forwardOut(remoteHost, remotePort).then(
        (stream) => {
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
          stream.on('close', () => socket.destroy());
        },
        () => socket.destroy(),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      server.close();
      throw new Error('Forward listener has no port');
    }

    const info: PortForwardInfo = {
      id: uuid(),
      hostId: host.id,
      hostName: host.name,
      remoteHost,
      remotePort,
      localHost: '127.0.0.1',
      localPort: addr.port,
      startedAt: Date.now(),
    };
    this.forwards.set(info.id, { info, server, sockets });
    return info;
  }

  list(): PortForwardInfo[] {
    return [...this.forwards.values()].map((f) => f.info);
  }

  close(id: string): boolean {
    const fwd = this.forwards.get(id);
    if (!fwd) return false;
    this.forwards.delete(id);
    for (const socket of fwd.sockets) socket.destroy();
    fwd.server.close();
    return true;
  }

  /** A host disconnected — its tunnels are dead, tear their listeners down. */
  closeForHost(hostId: string): number {
    let n = 0;
    for (const f of [...this.forwards.values()]) {
      if (f.info.hostId === hostId && this.close(f.info.id)) n += 1;
    }
    return n;
  }

  disposeAll(): void {
    for (const id of [...this.forwards.keys()]) this.close(id);
  }
}
