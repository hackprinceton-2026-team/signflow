/**
 * A stand-in SignFlow backend for e2e runs, on the same origin the app's CSP
 * allows (http://localhost:8000). Every request and response is validated
 * against the pinned contract (contract/openapi.json), and CORS behaves like the
 * real backend's (only app://signflow), so Chromium enforces the preflights.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const doc = JSON.parse(readFileSync(join(__dirname, '..', '..', 'contract', 'openapi.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(doc, 'contract');
const validator = (name: string) => ajv.getSchema(`contract#/components/schemas/${name}`)!;

export interface RecordedRequest {
  method: string;
  path: string;
  origin: string | undefined;
  body: unknown;
}

/** A few silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz) so playback has real audio. */
function silentMp3(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat(Array.from({ length: 12 }, () => frame));
}

export class MockBackend {
  readonly requests: RecordedRequest[] = [];
  readonly violations: string[] = [];
  translate: (glosses: string[], mode: string) => string = (g, mode) => `[AI ${mode}] ${g.join(' ').toLowerCase()}`;
  private server: Server | null = null;

  constructor(
    readonly port = 8000,
    readonly allowedOrigin = 'app://signflow',
  ) {}

  callsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path && r.method !== 'OPTIONS');
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  /** Simulates the backend going away (connection refused). */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private send(res: ServerResponse, status: number, body: unknown, schema?: string, origin?: string) {
    if (schema) {
      const validate = validator(schema);
      if (!validate(body)) this.violations.push(`response ${schema}: ${ajv.errorsText(validate.errors)}`);
    }
    if (origin === this.allowedOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    this.requests.push({ method: req.method ?? 'GET', path, origin, body });

    if (req.method === 'OPTIONS') {
      if (origin !== this.allowedOrigin) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    const error = (status: number, code: string, message: string) => this.send(res, status, { error: { code, message } }, 'ErrorResponse', origin);
    const checkRequest = (schema: string): boolean => {
      const validate = validator(schema);
      if (validate(body)) return true;
      this.violations.push(`request ${schema}: ${ajv.errorsText(validate.errors)}`);
      error(422, 'invalid_request', 'Request does not match the contract.');
      return false;
    };

    if (req.method === 'GET' && path === '/health') {
      return this.send(res, 200, { status: 'ok', version: '0.2.0', translation: 'ready', speech: 'ready', model: 'e2e-fake' }, 'HealthResponse', origin);
    }
    if (req.method === 'POST' && path === '/translate') {
      if (!checkRequest('TranslationRequest')) return;
      const { raw_signs, mode = 'chat' } = body as { raw_signs: string[]; mode?: string };
      return this.send(res, 200, { translated_text: this.translate(raw_signs, mode), mode, model: 'e2e-fake' }, 'TranslationResponse', origin);
    }
    if (req.method === 'POST' && path === '/speak') {
      if (!checkRequest('SpeechRequest')) return;
      const { voice_id } = body as { voice_id?: string };
      return this.send(
        res,
        200,
        { audio_base64: silentMp3().toString('base64'), audio_format: 'mp3', voice_id: voice_id ?? 'Joanna' },
        'SpeechResponse',
        origin,
      );
    }
    error(404, 'not_found', 'Not found.');
  }
}
