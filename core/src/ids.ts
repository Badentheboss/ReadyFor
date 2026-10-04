const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export type IdPrefix = "pat" | "sur" | "req" | "tsk" | "msg" | "doc" | "evt" | "alr" | "ntf" | "stf";

/** e.g. newId("req") -> "req_Qe3vZk0aB9xT" */
export function newId(prefix: IdPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}
