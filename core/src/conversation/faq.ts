import type { FaqTopic } from "../types.ts";

/**
 * The clinic's fixed patient instructions. Generic logistics only.
 * Nothing here gives fasting times, medicine advice, or any clinical rule.
 */
export function faqAnswer(topic: FaqTopic, clinicPhone: string): string | null {
  switch (topic) {
    case "fasting":
      return `Your care team will send the exact fasting times for your surgery. Please follow those. I can flag your question to the team if you'd like. For anything specific, call ${clinicPhone}.`;
    case "arrival":
      return `Your care team will confirm your arrival time before surgery. Please plan to check in at the front desk of the surgical center and allow time to park. For anything specific, call ${clinicPhone}.`;
    case "what_to_bring":
      return `Please bring a photo ID and your insurance card. Wear comfortable, loose clothing and leave valuables at home. Your care team will send anything else specific to your surgery. For questions, call ${clinicPhone}.`;
    case "medications":
    case "none":
      return null;
  }
}
