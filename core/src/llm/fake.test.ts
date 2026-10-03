import { describe, expect, test } from "bun:test";
import type { ConversationContext, FaqTopic, Intent } from "../types.ts";
import { createFakeLlm } from "./fake.ts";

const llm = createFakeLlm();
const context: ConversationContext = {
  patientFirstName: "Harriet",
  procedureName: "Total knee replacement (right)",
  surgeryDate: "2026-10-08",
  openRequirements: [
    { key: "preop_labs", title: "Pre-op blood work within 30 days" },
    { key: "transport", title: "Ride home confirmed" },
  ],
  recent: [],
};

const cases: Array<[string, Intent, string | null, FaqTopic | null]> = [
  ["I did that test at another clinic last week", "outside_result_claim", "preop_labs", null],
  ["I had blood work done at Quillhaven on Tuesday", "outside_result_claim", "preop_labs", null],
  ["I can't get a ride home", "transport_issue", "transport", null],
  ["I don't have anyone to drive me", "transport_issue", "transport", null],
  ["My daughter is driving me", "transport_confirmed", "transport", null],
  ["my husband will pick me up", "transport_confirmed", "transport", null],
  ["I've had a cough since Sunday", "health_concern", null, null],
  ["I have a fever", "health_concern", null, null],
  ["I feel sick", "health_concern", null, null],
  ["What can I eat the night before?", "question", null, "fasting"],
  ["What time should I arrive?", "question", null, "arrival"],
  ["What should I bring?", "question", null, "what_to_bring"],
  ["Should I stop my blood thinner?", "question", null, "medications"],
  ["do I take my metformin that morning", "question", null, "medications"],
  ["ok thanks", "acknowledgement", null, null],
  ["got it", "acknowledgement", null, null],
  ["can we move the date", "reschedule_request", null, null],
  ["The parking lot was full last time I visited a friend", "other", null, null],
  ["no one is available to take me home", "transport_issue", "transport", null],
];

describe("fake classifier", () => {
  for (const [body, intent, requirementKey, faqTopic] of cases) {
    test(`"${body}" is ${intent}`, async () => {
      const c = await llm.classifyReply({ body, context });
      expect(c.intent).toBe(intent);
      expect(c.requirementKey).toBe(requirementKey);
      expect(c.faqTopic).toBe(faqTopic);
      expect(c.confidence).toBeGreaterThanOrEqual(0.5);
      expect(c.summary.length).toBeGreaterThan(0);
    });
  }

  test("requirementKey is null when the requirement is not open", async () => {
    const c = await llm.classifyReply({ body: "I can't get a ride home", context: { ...context, openRequirements: [] } });
    expect(c.intent).toBe("transport_issue");
    expect(c.requirementKey).toBeNull();
  });

  test("an empty message has low confidence", async () => {
    const c = await llm.classifyReply({ body: "   ", context });
    expect(c.intent).toBe("other");
    expect(c.confidence).toBeLessThan(0.5);
  });
});

describe("fake document reader", () => {
  const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

  test("returns JSON that carries isLabReport", async () => {
    const report = { isLabReport: true, patientName: "Harriet Lindqvist", collectedDate: "2026-09-29", facility: "Quillhaven", results: [], confidence: 0.9, notes: null };
    expect(await llm.extractLabDocument({ mimeType: "image/jpeg", base64: encode(JSON.stringify(report)) })).toEqual(report);
  });

  test("reports that nothing was read for ordinary bytes", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0x81]).toString("base64");
    const result = await llm.extractLabDocument({ mimeType: "image/jpeg", base64: bytes });
    expect(result.isLabReport).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.notes).toContain("No AI model is configured");
  });

  test("ignores JSON without isLabReport", async () => {
    const result = await llm.extractLabDocument({ mimeType: "image/png", base64: encode('{"hello":1}') });
    expect(result.isLabReport).toBe(false);
  });
});
