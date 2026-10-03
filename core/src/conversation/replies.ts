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
  return `Thanks for telling me, ${first}. I've asked our coordinator to call you and help arrange a ride home.`;
}

export function rideNoted(first: string): string {
  return `Thanks, ${first}. I've noted who will be taking you home. The care team will confirm it with you.`;
}

export function symptomCallback(first: string, clinicPhone: string): string {
  return `Thank you for letting us know, ${first}. A nurse will call you about this. If you feel very unwell, please call ${clinicPhone}, or call 911 in an emergency.`;
}

export function medicationQuestion(first: string): string {
  return `Thanks for asking, ${first}. I can't advise on medicines. I've passed your question to a nurse, who will get back to you.`;
}

export function questionPassedOn(first: string): string {
  return `Thanks, ${first}. I've passed your question to the care team, and someone will get back to you.`;
}

export function faqReply(topic: FaqTopic, clinicPhone: string): string | null {
  return faqAnswer(topic, clinicPhone);
}

export function acknowledgementReply(first: string): string {
  return `You're welcome, ${first}. Message me any time.`;
}

export function rescheduleCallback(first: string): string {
  return `Thanks, ${first}. I've asked our coordinator to call you about your surgery date.`;
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
