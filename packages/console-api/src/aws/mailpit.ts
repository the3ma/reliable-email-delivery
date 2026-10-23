import { z } from 'zod';
import type { MailClient, MailMessage, MailSummary } from '../ports.js';

const Address = z.object({ Address: z.string() }).loose();

const Summary = z
  .object({
    ID: z.string(),
    MessageID: z.string().default(''),
    To: z.array(Address).nullable().default([]),
    Subject: z.string().default(''),
    Created: z.string().default(''),
    Size: z.number().default(0),
  })
  .loose();

const List = z
  .object({ total: z.number().default(0), messages: z.array(Summary).default([]) })
  .loose();

const Message = z
  .object({
    ID: z.string(),
    MessageID: z.string().default(''),
    From: Address.nullable().default(null),
    To: z.array(Address).nullable().default([]),
    Subject: z.string().default(''),
    Date: z.string().default(''),
    Text: z.string().default(''),
    HTML: z.string().default(''),
    Size: z.number().default(0),
  })
  .loose();

const HeaderMap = z.record(z.string(), z.array(z.string()));

function summary(raw: z.infer<typeof Summary>): MailSummary {
  return {
    id: raw.ID,
    messageId: raw.MessageID,
    to: (raw.To ?? []).map((a) => a.Address),
    subject: raw.Subject,
    createdAt: raw.Created,
    size: raw.Size,
  };
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Mailpit REST API v1 (https://mailpit.axllent.org/docs/api-v1/). */
export class MailpitClient implements MailClient {
  private readonly headerCache = new Map<string, Record<string, string[]>>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 5_000,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.call(path);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`mailpit ${path}: HTTP ${String(response.status)}`);
    return response.json();
  }

  async list(start: number, limit: number): Promise<{ total: number; messages: MailSummary[] }> {
    const parsed = List.parse(
      await this.json(`/api/v1/messages?start=${String(start)}&limit=${String(limit)}`),
    );
    return { total: parsed.total, messages: parsed.messages.map(summary) };
  }

  async get(id: string): Promise<MailMessage | undefined> {
    const raw = await this.json(`/api/v1/message/${encodeURIComponent(id)}`);
    if (raw === undefined) return undefined;
    const m = Message.parse(raw);
    return {
      id: m.ID,
      messageId: m.MessageID,
      from: m.From?.Address ?? '',
      to: (m.To ?? []).map((a) => a.Address),
      subject: m.Subject,
      createdAt: m.Date,
      size: m.Size,
      text: m.Text,
      html: m.HTML,
    };
  }

  /** Messages never change once stored, so headers are cached per id. */
  async headers(id: string): Promise<Record<string, string[]> | undefined> {
    const cached = this.headerCache.get(id);
    if (cached) return cached;
    const raw = await this.json(`/api/v1/message/${encodeURIComponent(id)}/headers`);
    if (raw === undefined) return undefined;
    const headers = HeaderMap.parse(raw);
    if (this.headerCache.size > 5_000) this.headerCache.clear();
    this.headerCache.set(id, headers);
    return headers;
  }

  async findByMessageId(messageId: string): Promise<string | undefined> {
    const query = encodeURIComponent(`message-id:"${messageId}"`);
    const raw = await this.json(`/api/v1/search?query=${query}&limit=5`);
    const found = raw === undefined ? [] : List.parse(raw).messages;
    return found.find((m) => m.MessageID === messageId)?.ID;
  }

  async deleteAll(): Promise<void> {
    const response = await this.call('/api/v1/messages', { method: 'DELETE' });
    if (!response.ok) throw new Error(`mailpit delete: HTTP ${String(response.status)}`);
    this.headerCache.clear();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.call('/api/v1/info')).ok;
    } catch {
      return false;
    }
  }
}

/** Header names from Mailpit are canonicalised (`X-Tag-Deliveryid`), so look them up case-insensitively. */
export function header(
  headers: Record<string, string[]> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return values[0];
  }
  return undefined;
}
