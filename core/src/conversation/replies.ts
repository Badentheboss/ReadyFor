import type { EvidenceCheck, FaqTopic } from "../types.ts";
import { faqAnswer } from "./faq.ts";

/**
 * Every patient-facing string lives here. The model never writes these.
 * Rules: warm, brief, plain, first name once, under 320 characters, and never
 * say or imply the surgery is cancelled, cleared, or safe.
 */

export function askForReportPhoto(first: string): string {
  return `Thanks, ${first}. If you have the results, text me a photo of the report and I will pass it to your care team.`;
}

export function rideHelp(first: string): string {
  return `Thanks for telling me, ${first}. I've asked our coordinator to help arrange a ride home, and they'll be in touch.`;
}

export function rideNoted(first: string): string {
  return `Thanks, ${first}. I've noted who will be taking you home. The care team will confirm it with you.`;
}

// Promise only what has happened: the concern is flagged now; the patient is told who has it once someone acknowledges.
export function symptomCallback(first: string, clinicPhone: string): string {
  return `Thank you for letting us know, ${first}. I've sent this to your care team as urgent, and I'll text you as soon as someone has picked it up. If you feel very unwell, please call ${clinicPhone}, or call 911 in an emergency.`;
}

export function medicationQuestion(first: string): string {
  return `Thanks for asking, ${first}. I can't advise on medicines, so I've passed your question to a nurse on your care team.`;
}

export function questionPassedOn(first: string): string {
  return `Thanks, ${first}. I've passed your question to your care team.`;
}

export function faqReply(topic: FaqTopic, clinicPhone: string): string | null {
  return faqAnswer(topic, clinicPhone);
}

export function acknowledgementReply(first: string): string {
  return `You're welcome, ${first}. Message me any time.`;
}

/** Answers a greeting with the one thing the patient can still help with, most important first. */
export function greetingReply(first: string, openKeys: string[]): string {
  const asks: Array<[string, string]> = [
    ["preop_labs", "If you've had blood work done recently, you can text me a photo of the report."],
    ["transport", "Who will be driving you home after surgery?"],
    ["fasting_ack", "Please reply to confirm you've read the eating and drinking instructions for the night before."],
  ];
  const next = asks.find(([key]) => openKeys.includes(key));
  return next ? `Hi ${first}, thanks for getting in touch. ${next[1]}` : `Hi ${first}, thanks for getting in touch. Message me any time if you have a question.`;
}

export function rescheduleCallback(first: string): string {
  return `Thanks, ${first}. I've passed your request about the surgery date to our coordinator.`;
}

export function passedToTeam(first: string): string {
  return `Thanks, ${first}. I've passed your message to the care team.`;
}

export function labReportReceived(first: string, checks: EvidenceCheck[]): string {
  const base = `Thank you, ${first}. I've received your lab report and the care team will review it.`;
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return base;
  if (failed.length > 1) {
    return `${base} A few things on it need a closer look, so the team may follow up with you.`;
  }
  const [only] = failed;
  if (only?.label.startsWith("Collected")) {
    if (only.detail.startsWith("No collection date")) {
      return `${base} I couldn't find a collection date on it, so the team may ask for another copy.`;
    }
    if (only.detail.endsWith("before surgery")) {
      return `${base} It looks like it was collected more than 30 days before your surgery, so the team may need a newer test.`;
    }
    return `${base} The collection date on it doesn't look right, so the team may follow up with you.`;
  }
  if (only?.label.startsWith("Patient name")) {
    return `${base} The name on it doesn't seem to match yours, so the team will take a closer look.`;
  }
  return `${base} Some of the usual results seem to be missing, so the team may ask for more.`;
}

export function labAlreadyCovered(first: string): string {
  return `Thanks, ${first}. I've saved your file. The care team already has what they need for your blood work.`;
}

export function photoUnreadable(first: string): string {
  return `Thanks, ${first}. I couldn't read that one. Could you send a clearer photo of the full page, with all four corners in view?`;
}
