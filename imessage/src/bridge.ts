import type { InboundAttachment, InboundResult, Message } from "../../core/src/types.ts";

/** A file the patient sent, read lazily so a failed download only loses that file. */
export interface IncomingAttachment {
  mimeType: string;
  read(): Promise<Uint8Array>;
}

export interface IncomingMessage {
  /** The sender's address: E.164 phone number for iMessage, sometimes an email. */
  phone: string;
  text: string;
  attachments: IncomingAttachment[];
}

/** Everything the bridge needs from a chat network. spectrum.ts implements it for iMessage. */
export interface Transport {
  /** Calls `handler` for each inbound message. Resolves when the stream ends. */
  start(handler: (message: IncomingMessage) => Promise<void>): Promise<void>;
  send(phone: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface BridgeOptions {
  transport: Transport;
  coreUrl: string;
  clinic: { name: string; phone: string };
  fetch?: typeof fetch;
  /** IMESSAGE_SERVICE_TOKEN, sent as a bearer token when the core has auth on. */
  serviceToken?: string;
  log?: (line: string) => void;
  /** Outbox poll interval. Default 3000. */
  pollMs?: number;
}

type OutboxMessage = Message & { phone: string | null };

export function createBridge(opts: BridgeOptions) {
  const rawFetch = opts.fetch ?? fetch;
  const authHeader: Record<string, string> = opts.serviceToken ? { authorization: `Bearer ${opts.serviceToken}` } : {};
  const doFetch = (url: string, init: RequestInit = {}) =>
    rawFetch(url, { ...init, headers: { ...authHeader, ...(init.headers as Record<string, string> | undefined) } });
  const log = opts.log ?? ((line: string) => console.log(line));
  const base = opts.coreUrl.replace(/\/+$/, "");
  const pollMs = opts.pollMs ?? 3000;

  // Ids already sent to the patient but not yet acknowledged by the core. Prevents a double send
  // when marking a message as sent fails and the message shows up in the next poll.
  const delivered = new Set<string>();
  const warnedNoPhone = new Set<string>();
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function handleIncoming(message: IncomingMessage): Promise<void> {
    const attachments: InboundAttachment[] = [];
    for (const file of message.attachments) {
      try {
        const bytes = await file.read();
        attachments.push({ mimeType: file.mimeType, base64: Buffer.from(bytes).toString("base64") });
      } catch (err) {
        log(`attachment download failed (${file.mimeType}): ${describe(err)}`);
      }
    }
    const text = message.text.trim();
    if (!text && attachments.length === 0) return;

    log(`in  ${maskPhone(message.phone)}: ${preview(text)}${attachments.length ? ` [+${attachments.length} file]` : ""}`);

    let res: Response;
    try {
      res = await doFetch(`${base}/messages/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "imessage", phone: message.phone, body: text, attachments }),
      });
    } catch (err) {
      log(`core unreachable for inbound message: ${describe(err)}`);
      return;
    }

    if (res.status === 404 && (await errorCode(res)) === "unknown_sender") {
      await sendLogged(message.phone, `This number isn't linked to an upcoming surgery at ${opts.clinic.name}. Please call ${opts.clinic.phone} if you need help.`);
      return;
    }
    if (!res.ok) {
      log(`core returned ${res.status} for inbound message; nothing sent`);
      return;
    }

    const result = (await res.json().catch(() => null)) as InboundResult | null;
    for (const reply of result?.replies ?? []) {
      await sendLogged(message.phone, reply);
    }
  }

  async function sendLogged(phone: string, text: string): Promise<void> {
    try {
      await opts.transport.send(phone, text);
      log(`out ${maskPhone(phone)}: ${preview(text)}`);
    } catch (err) {
      log(`send to ${maskPhone(phone)} failed: ${describe(err)}`);
    }
  }

  async function markSent(id: string): Promise<boolean> {
    try {
      const res = await doFetch(`${base}/outbox/${encodeURIComponent(id)}/sent`, { method: "POST" });
      if (!res.ok) {
        log(`could not mark ${id} as sent (HTTP ${res.status}); will retry the mark only`);
        return false;
      }
      return true;
    } catch (err) {
      log(`could not mark ${id} as sent: ${describe(err)}; will retry the mark only`);
      return false;
    }
  }

  /** One pass over the outbox. Exposed so tests can drive it without timers. */
  async function pollOutbox(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      let messages: OutboxMessage[];
      try {
        const res = await doFetch(`${base}/outbox?channel=imessage`);
        if (!res.ok) {
          log(`outbox poll failed: HTTP ${res.status}`);
          return;
        }
        messages = ((await res.json()) as { messages: OutboxMessage[] }).messages ?? [];
      } catch (err) {
        log(`outbox poll failed: ${describe(err)}`);
        return;
      }

      for (const m of messages) {
        if (!delivered.has(m.id)) {
          if (!m.phone) {
            if (!warnedNoPhone.has(m.id)) {
              warnedNoPhone.add(m.id);
              log(`outbox message ${m.id} has no phone number; leaving it queued`);
            }
            continue;
          }
          try {
            await opts.transport.send(m.phone, m.body);
          } catch (err) {
            log(`send of outbox message ${m.id} failed: ${describe(err)}; will retry`);
            continue;
          }
          delivered.add(m.id);
          log(`out ${maskPhone(m.phone)}: ${preview(m.body)}`);
        }
        if (await markSent(m.id)) delivered.delete(m.id);
      }
    } finally {
      polling = false;
    }
  }

  function scheduleNextPoll(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      await pollOutbox();
      scheduleNextPoll();
    }, pollMs);
  }

  /** Runs until the transport's stream ends. */
  async function start(): Promise<void> {
    stopped = false;
    scheduleNextPoll();
    await opts.transport.start(async (message) => {
      try {
        await handleIncoming(message);
      } catch (err) {
        log(`unexpected error handling inbound message: ${describe(err)}`);
      }
    });
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    await opts.transport.stop();
  }

  return { start, stop, handleIncoming, pollOutbox };
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const json = (await res.json()) as { error?: { code?: string } };
    return json.error?.code ?? null;
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Message bodies are health-adjacent: logs only ever carry the first 40 characters. */
export function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat);
}

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? phone : `***${phone.slice(-4)}`;
}
