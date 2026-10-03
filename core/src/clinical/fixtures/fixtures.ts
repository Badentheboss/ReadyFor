import type { DrugClassifier, RecordSource } from "../../types.ts";
import { normaliseRecord } from "../finchnode.ts";
import { createRxClassClassifier } from "../rxclass.ts";
import harriet from "./harriet.record.json" with { type: "json" };
import rxclass from "./rxclass.json" with { type: "json" };

const RECORDS: Record<string, unknown> = {
  "patient-demo-polypharmacy": harriet,
};

/** Offline record source (RECORD_FIXTURES=1). Runs the real normaliser over a saved FinchNode response. */
export function createFixtureSource(): RecordSource {
  return {
    async getRecord(subject) {
      const body = Object.hasOwn(RECORDS, subject) ? RECORDS[subject] : undefined;
      if (!body) {
        throw new Error(
          `No fixture record for subject "${subject}". Fixtures exist for: ${Object.keys(RECORDS).join(", ")}. Unset RECORD_FIXTURES to use the live API.`,
        );
      }
      return normaliseRecord(subject, body);
    },
  };
}

type Canned = Record<string, unknown>;

/** Offline classifier: the real RxClass client pointed at canned answers, so parsing and tagging are the production code. */
export function createFixtureClassifier(): DrugClassifier {
  const byRxcui = rxclass.byRxcui as Canned;
  const byDrugName = rxclass.byDrugName as Canned;
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const rxcui = url.searchParams.get("rxcui");
    const drugName = url.searchParams.get("drugName")?.toLowerCase();
    const body = (rxcui ? byRxcui[rxcui] : drugName ? byDrugName[drugName] : undefined) ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return createRxClassClassifier({ baseUrl: "http://fixtures.invalid/REST", fetch: fakeFetch });
}
