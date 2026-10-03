import type { Classification, ConversationContext, FaqTopic, Intent, Llm, LabExtraction } from "../types.ts";

/**
 * Keyword classifier and JSON-passthrough document reader. It exists so the whole
 * demo runs with no API key, and it is also the fallback when Gemini fails.
 * Rules are ordered: the first match wins.
 */

const NEGATION = /\b(can'?t|cannot|can not|no one|nobody|don'?t have|do not have|dont have|no ride|without|unable|won'?t have|haven'?t got|not able)\b/;
const TRANSPORT_WORDS = /\b(ride|rides|drive|drives|driving|driver|drove|pick me up|picked up|pick up|get home|getting home|take me home|bring me home|get me home|taxi|uber|lyft|transport|transportation)\b/;
const LAB_WORDS = /\b(test|tests|blood work|bloodwork|blood test|blood tests|blood draw|labs|lab work|lab test|lab results|bloods)\b/;
const SYMPTOM_WORDS =
  /\b(cough|coughing|fever|feverish|sick|nausea|nauseous|vomit|vomiting|throw(ing)? up|diarrhea|rash|chills|sore throat|runny nose|flu|cold|infection|infected|dizzy|chest pain|short of breath|shortness of breath|can'?t breathe|unwell|not feeling well|under the weather|headache|swollen|swelling)\b/;
const MEDICATION_WORDS =
  /\b(medication|medications|medicine|medicines|meds|pill|pills|blood thinner|blood thinners|thinner|metformin|aspirin|apixaban|eliquis|warfarin|insulin|ibuprofen|advil|lisinopril|prescription|supplement|supplements|vitamin|vitamins)\b/;
const RESCHEDULE_WORDS =
  /\b(reschedule|re-schedule|postpone|move the date|move my surgery|move the surgery|move it|change the date|different day|another day|another date|push (it )?back|delay the surgery)\b/;
const ACK_WORDS = new Set([
  "ok", "okay", "k", "kk", "thanks", "thank", "you", "thx", "ty", "got", "it", "great", "perfect", "sounds", "good",
  "will", "do", "understood", "noted", "awesome", "cool", "sure", "yes", "yep", "yup", "alright", "appreciate", "that", "so", "much", "very",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

function looksLikeQuestion(t: string): boolean {
  return t.includes("?") || /^(what|when|where|how|why|who|which|should i|can i|could i|do i|does|is it|is there|are there|will i|am i|may i)\b/.test(t);
}

function faqTopicFor(t: string): FaqTopic {
  if (MEDICATION_WORDS.test(t)) return "medications";
  if (/\b(eat|eating|drink|drinking|food|fast|fasting|water|coffee|tea|breakfast|dinner|midnight|nothing by mouth|gum|snack|meal)\b/.test(t)) return "fasting";
  if (/\b(bring|pack|wear|clothes|clothing|insurance card|id card|photo id|glasses|overnight bag)\b/.test(t)) return "what_to_bring";
  if (/\b(time|arrive|arrival|check in|check-in|park|parking|where do i go|what time|how early)\b/.test(t)) return "arrival";
  return "none";
}

function summarize(body: string): string {
  const clean = body.replace(/\s+/g, " ").trim();
  const clipped = clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
  return `Patient says: "${clipped}"`;
}

function isAcknowledgement(t: string): boolean {
  const words = t.replace(/[^a-z\s'-]/g, " ").split(" ").filter(Boolean);
  const hasOnlyEmoji = /^[\p{Extended_Pictographic}\s]+$/u.test(t);
  if (hasOnlyEmoji) return true;
  return words.length > 0 && words.length <= 5 && words.every((w) => ACK_WORDS.has(w));
}

export function classifyWithKeywords(input: { body: string; context: ConversationContext }): Classification {
  const { body, context } = input;
  const t = normalize(body);
  const openKeys = new Set(context.openRequirements.map((r) => r.key));
  const keyIfOpen = (key: string) => (openKeys.has(key) ? key : null);
  const result = (intent: Intent, confidence: number, requirementKey: string | null = null, faqTopic: FaqTopic | null = null): Classification => ({
    intent,
    confidence,
    summary: summarize(body),
    requirementKey,
    faqTopic,
  });

  if (!t) return result("other", 0.3);

  // The patient says they already had the test done somewhere else.
  const saysDone = /\b(i|i've|i have|we|already|just)\b.*\b(did|done|had|got|took|taken|have had|completed)\b/.test(t);
  const elsewhere = /\b(another clinic|other clinic|another hospital|other hospital|elsewhere|my own doctor|my doctor'?s|urgent care)\b/.test(t);
  if (LAB_WORDS.test(t) && (saysDone || elsewhere) && !/^(do|did|does|should|can|what|when)\b.*\?$/.test(t)) {
    return result("outside_result_claim", 0.9, keyIfOpen("preop_labs"));
  }

  // Negated transport comes before confirmed transport on purpose.
  if (TRANSPORT_WORDS.test(t) && NEGATION.test(t)) return result("transport_issue", 0.9, keyIfOpen("transport"));

  if (SYMPTOM_WORDS.test(t) && !looksLikeQuestion(t)) return result("health_concern", 0.85, null);
  if (/\b(i have|i've got|i feel|i'm feeling|i am feeling|i've had)\b/.test(t) && SYMPTOM_WORDS.test(t)) return result("health_concern", 0.85, null);

  if (RESCHEDULE_WORDS.test(t)) return result("reschedule_request", 0.85);

  if (TRANSPORT_WORDS.test(t) && !looksLikeQuestion(t)) return result("transport_confirmed", 0.85, keyIfOpen("transport"));
  if (/\b(someone|my (daughter|son|wife|husband|partner|friend|neighbor|neighbour|sister|brother|mom|dad|mother|father)) (is|will|can|'ll)\b/.test(t) && /\b(me|home|hospital|surgery|there)\b/.test(t) && !looksLikeQuestion(t)) {
    return result("transport_confirmed", 0.75, keyIfOpen("transport"));
  }

  if (looksLikeQuestion(t)) {
    const topic = faqTopicFor(t);
    return result("question", topic === "none" ? 0.7 : 0.9, null, topic);
  }

  if (isAcknowledgement(t)) return result("acknowledgement", 0.9);

  return result("other", 0.6);
}

const NOT_READ: LabExtraction = {
  isLabReport: false,
  patientName: null,
  collectedDate: null,
  facility: null,
  results: [],
  confidence: 0,
  notes: "No AI model is configured, so this document was not read.",
};

/** Offline demo trick: a document whose bytes are a JSON LabExtraction is "read" as that. */
function readJsonDocument(base64: string): LabExtraction | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"));
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "isLabReport" in parsed) return parsed as LabExtraction;
  } catch {
    // Not text or not JSON: an ordinary image or PDF.
  }
  return null;
}

export function createFakeLlm(): Llm {
  return {
    name: "fake",
    async classifyReply(input) {
      return classifyWithKeywords(input);
    },
    async extractLabDocument(input) {
      return readJsonDocument(input.base64) ?? { ...NOT_READ };
    },
  };
}
