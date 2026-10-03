import { describe, expect, test } from "bun:test";
import { createBridge, type IncomingMessage, type Transport } from "./bridge.ts";

const CLINIC = { name: "Northstar Surgical Center", phone: "(734) 555-0100" };

function fakeTransport() {
  const sent: Array<{ phone: string; text: string }> = [];
  let failNextSend = false;
  const transport: Transport = {
    async start() {},
    async send(phone, text) {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("network down");
      }
      sent.push({ phone, text });
    },
    async stop() {},
  };
  return { transport, sent, failNextSend: () => (failNextSend = true) };
}

interface Call {
  method: string;
  url: string;
  body: any;
}

function fakeCore(routes: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return routes(call);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function setup(routes: (call: Call) => Response | Promise<Response>) {
  const t = fakeTransport();
  const core = fakeCore(routes);
  const logs: string[] = [];
  const bridge = createBridge({ transport: t.transport, coreUrl: "http://core.test/", clinic: CLINIC, fetch: core.impl, log: (l) => logs.push(l) });
  return { ...t, core, logs, bridge };
}

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({ phone: "+17345550100", text: "hello", attachments: [], ...over });

describe("inbound", () => {
  test("posts text to the core and sends each reply in order", async () => {
    const s = setup(() => json({ surgeryId: "sur_1", messageId: "msg_1", classification: null, replies: ["one", "two"], effects: [] }));
    await s.bridge.handleIncoming(msg({ text: "I can't get a ride home" }));
    expect(s.core.calls).toHaveLength(1);
    expect(s.core.calls[0]).toMatchObject({ method: "POST", url: "http://core.test/messages/inbound" });
    expect(s.core.calls[0]?.body).toEqual({ channel: "imessage", phone: "+17345550100", body: "I can't get a ride home", attachments: [] });
    expect(s.sent).toEqual([{ phone: "+17345550100", text: "one" }, { phone: "+17345550100", text: "two" }]);
  });

  test("passes a photo through as base64", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const s = setup(() => json({ surgeryId: "s", messageId: "m", classification: null, replies: ["Thanks"], effects: [] }));
    await s.bridge.handleIncoming(msg({ text: "", attachments: [{ mimeType: "image/jpeg", read: async () => bytes }] }));
    const body = s.core.calls[0]?.body;
    expect(body.attachments).toEqual([{ mimeType: "image/jpeg", base64: Buffer.from(bytes).toString("base64") }]);
    expect(body.body).toBe("");
    expect(s.sent).toHaveLength(1);
  });

  test("a failed download drops that file but still sends the text", async () => {
    const s = setup(() => json({ replies: [] }));
    await s.bridge.handleIncoming(msg({ attachments: [{ mimeType: "image/png", read: async () => { throw new Error("expired"); } }] }));
    expect(s.core.calls[0]?.body.attachments).toEqual([]);
    expect(s.logs.some((l) => l.includes("attachment download failed"))).toBe(true);
  });

  test("an empty message with no files is ignored", async () => {
    const s = setup(() => json({ replies: [] }));
    await s.bridge.handleIncoming(msg({ text: "  " }));
    expect(s.core.calls).toHaveLength(0);
  });

  test("unknown sender gets one neutral reply", async () => {
    const s = setup(() => json({ error: { code: "unknown_sender", message: "No scheduled surgery matches this sender" } }, 404));
    await s.bridge.handleIncoming(msg());
    expect(s.sent).toEqual([
      { phone: "+17345550100", text: "This number isn't linked to an upcoming surgery at Northstar Surgical Center. Please call (734) 555-0100 if you need help." },
    ]);
  });

  test("a 404 with another code sends nothing", async () => {
    const s = setup(() => json({ error: { code: "not_found", message: "x" } }, 404));
    await s.bridge.handleIncoming(msg());
    expect(s.sent).toEqual([]);
  });

  test("a core error logs and sends nothing", async () => {
    const s = setup(() => json({ error: { code: "bad_request", message: "x" } }, 500));
    await s.bridge.handleIncoming(msg());
    expect(s.sent).toEqual([]);
    expect(s.logs.some((l) => l.includes("500"))).toBe(true);
  });

  test("an unreachable core logs and sends nothing", async () => {
    const s = setup(() => {
      throw new Error("ECONNREFUSED");
    });
    await s.bridge.handleIncoming(msg());
    expect(s.sent).toEqual([]);
    expect(s.logs.some((l) => l.includes("ECONNREFUSED"))).toBe(true);
  });

  test("logs show at most the first 40 characters of a body", async () => {
    const long = "x".repeat(41) + "SECRETTAIL";
    const s = setup(() => json({ replies: [long] }));
    await s.bridge.handleIncoming(msg({ text: long }));
    expect(s.logs.join("\n")).not.toContain("SECRETTAIL");
    expect(s.logs.join("\n")).not.toContain("+17345550100");
  });
});

describe("outbox", () => {
  const queued = (id: string, phone: string | null, body = `body ${id}`) => ({ id, phone, body, direction: "out", channel: "imessage", deliveryStatus: "queued" });

  test("sends queued messages with a phone and marks them sent", async () => {
    const s = setup((c) => (c.url.includes("/outbox?") ? json({ messages: [queued("msg_1", "+17345550100"), queued("msg_2", "+17345550111")] }) : json({ message: {} })));
    await s.bridge.pollOutbox();
    expect(s.core.calls[0]?.url).toBe("http://core.test/outbox?channel=imessage");
    expect(s.sent).toEqual([{ phone: "+17345550100", text: "body msg_1" }, { phone: "+17345550111", text: "body msg_2" }]);
    expect(s.core.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["http://core.test/outbox/msg_1/sent", "http://core.test/outbox/msg_2/sent"]);
  });

  test("a message with no phone is left queued and logged once", async () => {
    const s = setup((c) => (c.url.includes("/outbox?") ? json({ messages: [queued("msg_3", null)] }) : json({})));
    await s.bridge.pollOutbox();
    await s.bridge.pollOutbox();
    expect(s.sent).toEqual([]);
    expect(s.core.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(s.logs.filter((l) => l.includes("msg_3"))).toHaveLength(1);
  });

  test("a message is not sent twice when marking it sent fails once", async () => {
    let markAttempts = 0;
    let stillQueued = true;
    const s = setup((c) => {
      if (c.url.includes("/outbox?")) return json({ messages: stillQueued ? [queued("msg_4", "+17345550100")] : [] });
      markAttempts += 1;
      if (markAttempts === 1) return json({ error: { code: "x", message: "x" } }, 500);
      stillQueued = false;
      return json({ message: {} });
    });
    await s.bridge.pollOutbox();
    await s.bridge.pollOutbox();
    await s.bridge.pollOutbox();
    expect(s.sent).toHaveLength(1);
    expect(markAttempts).toBe(2);
  });

  test("a failed send is retried on the next poll without marking it sent", async () => {
    const s = setup((c) => (c.url.includes("/outbox?") ? json({ messages: [queued("msg_5", "+17345550100")] }) : json({})));
    s.failNextSend();
    await s.bridge.pollOutbox();
    expect(s.sent).toHaveLength(0);
    expect(s.core.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await s.bridge.pollOutbox();
    expect(s.sent).toHaveLength(1);
    expect(s.core.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("after three failed sends the message is reported failed and not sent again", async () => {
    let reported = false;
    const s = setup((c) => {
      if (c.url.includes("/outbox?")) return json({ messages: reported ? [] : [queued("msg_6", "+17345550100")] });
      if (c.url.endsWith("/failed")) reported = true;
      return json({ message: {} });
    });
    for (let i = 0; i < 4; i++) {
      s.failNextSend();
      await s.bridge.pollOutbox();
    }
    const posts = s.core.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual(["http://core.test/outbox/msg_6/failed"]);
    expect(posts[0]?.body).toEqual({ error: "network down" });
    expect(s.sent).toHaveLength(0);
  });

  test("a poll failure is logged and does not throw", async () => {
    const s = setup(() => json({}, 500));
    await s.bridge.pollOutbox();
    expect(s.logs.some((l) => l.includes("outbox poll failed"))).toBe(true);
  });
});
