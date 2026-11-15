/**
 * A stand-in for Umar's live.py WebSocket broadcaster (ws://localhost:8765),
 * for E2E runs without Python or a camera. Minimal RFC 6455: handshake, server
 * text frames, and noticing when a client goes away. It replays recorded
 * recognizer messages exactly as live.py sends them.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  if (len >= 65536) throw new Error('frame too large for this test server');
  return Buffer.concat([header, payload]);
}

export class FakeAslRecognizer {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  connections = 0;
  port = 0;

  /** Listen on 127.0.0.1 (a fixed port, or a free one when 0). */
  async start(port = 0): Promise<number> {
    const server = createServer((_req, res) => res.writeHead(426).end());
    server.on('upgrade', (req, socket: Socket) => {
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string') return socket.destroy();
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.connections++;
      this.clients.add(socket);
      // Any client frame (live.py ignores them too); a close frame (opcode 8) ends the connection.
      socket.on('data', (buf: Buffer) => {
        if ((buf[0]! & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0]));
      });
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(port || this.port || 0, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Send to every connected client, like live.py's Broadcaster. */
  send(msg: string | Record<string, unknown>): void {
    const frame = textFrame(typeof msg === 'string' ? msg : JSON.stringify(msg));
    for (const c of this.clients) c.write(frame);
  }

  /** Simulate the recognizer quitting: drop every client and stop listening. */
  async stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** live.py's messages, with `ts` in seconds as it sends them. */
export const asl = {
  sign: (sign: string, confidence: number, candidates: [string, number][] = [[sign, confidence]]) => ({
    type: 'sign',
    sign,
    confidence,
    candidates,
    ts: Date.now() / 1000,
  }),
  keyword: (candidates: [string, number][], confident: boolean) => ({
    type: 'sign',
    candidates,
    top1: candidates[0]![0],
    confident,
    ts: Date.now() / 1000,
  }),
  end: (signs: string[]) => ({ type: 'end_of_sentence', signs, ts: Date.now() / 1000 }),
};
