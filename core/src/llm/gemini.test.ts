import { describe, expect, test } from "bun:test";
import type { ConversationContext } from "../types.ts";
import { createGeminiLlm } from "./gemini.ts";
import { createLlm } from "./index.ts";

const context: ConversationContext = {
  patientFirstName: "Harriet",
  procedureName: "Total knee replacement (right)",
  surgeryDate: "2026-10-08",
  openRequirements: [{ key: "preop_labs", title: "Pre-op blood work within 30 days" }],
  recent: [{ direction: "out", body: "Hi Harriet" }],
};

interface Call {
  url: string;
  init: RequestInit;
  body: any;
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const geminiReply = (payload: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof payload === "string" ? payload : JSON.stringify(payload) }] } }] }), { status: 200 });

describe("gemini classifyReply", () => {
  test("sends the documented request shape", async () => {
    const f = fakeFetch(() => geminiReply({ intent: "question", confidence: 0.8, summary: "Asks about eating.", requirementKey: null, faqTopic: "fasting" }));
    const llm = createGeminiLlm({ apiKey: "KEY", model: "gemini-test", fetch: f.impl });
    expect(llm.name).toBe("gemini:gemini-test");
    await llm.classifyReply({ body: "What can I eat?", context });

    const call = f.calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("KEY");
    expect(call.body.systemInstruction.parts[0].text).toContain("classifier only");
    expect(call.body.contents[0].role).toBe("user");
    const prompt: string = call.body.contents[0].parts[0].text;
    expect(prompt).toContain("What can I eat?");
    expect(prompt).toContain("preop_labs");
    expect(prompt).toContain("Service: Hi Harriet");
    expect(call.body.generationConfig.responseMimeType).toBe("application/json");
    expect(call.body.generationConfig.temperature).toBe(0);
    expect(call.body.generationConfig.responseSchema.properties.intent.enum).toContain("outside_result_claim");
  });

  test("defaults the model to gemini-2.5-flash", () => {
    expect(createGeminiLlm({ apiKey: "k" }).name).toBe("gemini:gemini-2.5-flash");
  });

  test("returns a good response", async () => {
    const f = fakeFetch(() => geminiReply({ intent: "outside_result_claim", confidence: 0.93, summary: "Blood work done elsewhere.", requirementKey: "preop_labs", faqTopic: "none" }));
    const c = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).classifyReply({ body: "did it elsewhere", context });
    expect(c).toEqual({ intent: "outside_result_claim", confidence: 0.93, summary: "Blood work done elsewhere.", requirementKey: "preop_labs", faqTopic: null });
  });

  test("coerces bad values", async () => {
    const f = fakeFetch(() => geminiReply({ intent: "give_medical_advice", confidence: 7, summary: "x", requirementKey: "made_up", faqTopic: "weather" }));
    const c = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).classifyReply({ body: "hi", context });
    expect(c.intent).toBe("other");
    expect(c.confidence).toBe(1);
    expect(c.requirementKey).toBeNull();
    expect(c.faqTopic).toBeNull();
  });

  test("falls back to the keyword classifier on malformed output", async () => {
    const f = fakeFetch(() => geminiReply("this is not json"));
    const c = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).classifyReply({ body: "I can't get a ride home", context });
    expect(c.intent).toBe("transport_issue");
  });

  test("falls back on HTTP 500", async () => {
    const f = fakeFetch(() => new Response("boom", { status: 500 }));
    const c = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).classifyReply({ body: "got it", context });
    expect(c.intent).toBe("acknowledgement");
  });

  test("falls back when fetch throws", async () => {
    const llm = createGeminiLlm({ apiKey: "k", fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect((await llm.classifyReply({ body: "I have a fever", context })).intent).toBe("health_concern");
  });
});

describe("gemini extractLabDocument", () => {
  test("sends the file inline and parses the extraction", async () => {
    const f = fakeFetch(() =>
      geminiReply({
        isLabReport: true, patientName: "LINDQVIST, HARRIET", collectedDate: "2026-09-29", facility: "Quillhaven Medical Group",
        results: [{ name: "Hemoglobin", value: 12.9, unit: "g/dL", flag: null }, { name: "", value: "1", unit: null, flag: null }],
        confidence: 0.88, notes: null,
      }),
    );
    const out = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).extractLabDocument({ mimeType: "image/jpeg", base64: "QUJD" });
    const parts = f.calls[0]!.body.contents[0].parts;
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: "QUJD" } });
    expect(f.calls[0]!.body.systemInstruction.parts[0].text).toContain("Never guess");
    expect(out.isLabReport).toBe(true);
    expect(out.collectedDate).toBe("2026-09-29");
    expect(out.results).toEqual([{ name: "Hemoglobin", value: "12.9", unit: "g/dL", flag: null }]);
  });

  test("drops an impossible date", async () => {
    const f = fakeFetch(() => geminiReply({ isLabReport: true, patientName: null, collectedDate: "last Tuesday", facility: null, results: [], confidence: 0.5, notes: null }));
    const out = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).extractLabDocument({ mimeType: "image/png", base64: "QQ==" });
    expect(out.collectedDate).toBeNull();
  });

  test("returns a not-a-report result on HTTP 500", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 500 }));
    const out = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).extractLabDocument({ mimeType: "image/png", base64: "QQ==" });
    expect(out.isLabReport).toBe(false);
    expect(out.confidence).toBe(0);
    expect(out.notes).toStartWith("Could not read the document: ");
  });

  test("returns a not-a-report result on malformed JSON", async () => {
    const f = fakeFetch(() => geminiReply("{oops"));
    const out = await createGeminiLlm({ apiKey: "k", fetch: f.impl }).extractLabDocument({ mimeType: "image/png", base64: "QQ==" });
    expect(out.isLabReport).toBe(false);
    expect(out.notes).toStartWith("Could not read the document: ");
  });
});

describe("createLlm", () => {
  test("uses the fake model with no key", () => {
    expect(createLlm({}).name).toBe("fake");
    expect(createLlm({ GEMINI_API_KEY: "  " }).name).toBe("fake");
  });
  test("uses gemini with a key", () => {
    expect(createLlm({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-x" }).name).toBe("gemini:gemini-x");
    expect(createLlm({ GEMINI_API_KEY: "k" }).name).toBe("gemini:gemini-2.5-flash");
  });
});
