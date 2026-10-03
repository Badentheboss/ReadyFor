import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Content } from "spectrum-ts";
import type { IncomingAttachment, IncomingMessage, Transport } from "./bridge.ts";

/**
 * The real transport, over Photon's spectrum-ts iMessage provider.
 * Written against the installed v12.10.1 typings. The live connection has not been exercised.
 */
export function createSpectrumTransport(opts: { projectId: string; projectSecret: string }): Transport {
  type App = Awaited<ReturnType<typeof startApp>>;
  let app: App | null = null;
  let running = false;
  // DM spaces seen on inbound messages, so replies go to the exact chat the patient used.
  const spacesByPhone = new Map<string, { send(text: string): Promise<unknown> }>();

  async function startApp() {
    return await Spectrum({
      projectId: opts.projectId,
      projectSecret: opts.projectSecret,
      providers: [imessage.config()],
    });
  }

  return {
    async start(handler) {
      app = await startApp();
      running = true;
      for await (const [space, message] of app.messages) {
        if (!running) break;
        // Skip our own outgoing messages and anything that is not iMessage.
        if (message.direction !== "inbound") continue;
        if (!imessage.is(space)) continue;
        // Group chats are out of scope: replies would reach other people.
        if (space.type === "group") continue;

        const phone = message.sender?.id;
        if (!phone) continue;

        spacesByPhone.set(phone, space);
        const { text, attachments } = collect(message.content);
        await handler({ phone, text, attachments } satisfies IncomingMessage);
      }
    },

    async send(phone, text) {
      if (!app) throw new Error("iMessage transport is not started");
      let space = spacesByPhone.get(phone);
      if (!space) {
        // Proactive path, as documented in the Spectrum skill (spaces-and-users.md). The patient must have
        // opted in to texts from the clinic; cold outreach can get a line flagged.
        const im = imessage(app);
        space = await im.space.create(await im.user(phone));
        spacesByPhone.set(phone, space);
      }
      await space.send(text);
    },

    async stop() {
      running = false;
      await app?.stop();
    },
  };
}

/** Flattens inbound content. A message with a caption and photos arrives as a `group` of parts. */
function collect(content: Content): { text: string; attachments: IncomingAttachment[] } {
  const texts: string[] = [];
  const attachments: IncomingAttachment[] = [];

  const visit = (c: Content): void => {
    switch (c.type) {
      case "text":
        texts.push(c.text);
        break;
      case "attachment":
        attachments.push({ mimeType: c.mimeType, read: () => c.read() });
        break;
      case "group":
        for (const item of c.items) visit(item.content);
        break;
      default:
        // Reactions, typing, contacts, links and the rest carry nothing the core can use.
        break;
    }
  };
  visit(content);
  return { text: texts.join("\n").trim(), attachments };
}
