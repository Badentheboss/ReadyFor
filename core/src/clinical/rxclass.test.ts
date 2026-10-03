import { describe, expect, test } from "bun:test";
import { ingredientCandidates, createRxClassClassifier, tagsForClassId } from "./rxclass.ts";

const apixabanByRxcui = {
  rxclassDrugInfoList: {
    rxclassDrugInfo: [
      {
        minConcept: { rxcui: "1364430", name: "apixaban", tty: "IN" },
        rxclassMinConceptItem: { classId: "B01AF", className: "Direct factor Xa inhibitors", classType: "ATC1-4" },
        rela: "",
        relaSource: "ATC",
      },
    ],
  },
};

const entry = (name: string, tty: string, classId: string, className: string) => ({
  minConcept: { rxcui: "1", name, tty },
  rxclassMinConceptItem: { classId, className, classType: "ATC1-4" },
  rela: "",
  relaSource: "ATC",
});
const aspirinByName = {
  rxclassDrugInfoList: {
    rxclassDrugInfo: [
      entry("aspirin", "IN", "A01AD", "Other agents for local oral treatment"),
      entry("aspirin", "IN", "B01AC", "Platelet aggregation inhibitors excl. heparin"),
      entry("aspirin", "IN", "N02BA", "Salicylic acid and derivatives"),
      entry("aspirin / codeine", "MIN", "N02AJ", "Opioids in combination with non-opioid analgesics"),
    ],
  },
};

function fakeFetch(handler: (url: URL) => unknown | Response) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname + url.search);
    const out = handler(url);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("ingredientCandidates", () => {
  test("strips strengths, forms, hours and salts", () => {
    expect(ingredientCandidates("24 HR metoprolol succinate 50 MG Extended Release Oral Tablet")).toEqual(["metoprolol succinate", "metoprolol"]);
    expect(ingredientCandidates("Metformin hydrochloride 500 MG Oral Tablet")).toEqual(["metformin hydrochloride", "metformin"]);
    expect(ingredientCandidates("apixaban 5 MG Oral Tablet")).toEqual(["apixaban"]);
    expect(ingredientCandidates("Insulin glargine 100 UNT/ML Injectable Solution")).toEqual(["insulin glargine"]);
    expect(ingredientCandidates("Aspirin 81mg daily")).toEqual(["aspirin"]);
  });
});

describe("tagsForClassId", () => {
  test("mapping", () => {
    expect(tagsForClassId("B01AF")).toEqual(["anticoagulant"]);
    expect(tagsForClassId("B01AA")).toEqual(["anticoagulant"]);
    expect(tagsForClassId("B01AX")).toEqual(["anticoagulant"]);
    expect(tagsForClassId("B01AC")).toEqual(["antiplatelet"]);
    expect(tagsForClassId("A10BA")).toEqual(["diabetes"]);
    expect(tagsForClassId("N02BA")).toEqual([]);
  });
});

describe("createRxClassClassifier", () => {
  test("uses byRxcui when an rxcui is present", async () => {
    const { fn, calls } = fakeFetch(() => apixabanByRxcui);
    const c = createRxClassClassifier({ fetch: fn });
    const r = await c.classify({ name: "apixaban 5 MG Oral Tablet", rxcui: "1364445" });
    expect(r).toEqual({
      tags: ["anticoagulant"],
      classes: [{ classId: "B01AF", className: "Direct factor Xa inhibitors" }],
      lookup: "rxclass",
      ingredient: "apixaban",
    });
    expect(calls).toEqual(["/REST/rxclass/class/byRxcui.json?rxcui=1364445&relaSource=ATC"]);
  });

  test("falls back to the drug name without an rxcui, ignoring combination entries", async () => {
    const { fn, calls } = fakeFetch(() => aspirinByName);
    const r = await createRxClassClassifier({ fetch: fn }).classify({ name: "Aspirin 81 MG Oral Tablet", rxcui: null });
    expect(calls).toEqual(["/REST/rxclass/class/byDrugName.json?drugName=aspirin&relaSource=ATC"]);
    expect(r.tags).toEqual(["antiplatelet"]);
    expect(r.classes.map((x) => x.classId)).toEqual(["A01AD", "B01AC", "N02BA"]);
    expect(r.lookup).toBe("rxclass");
  });

  test("tries the salt-stripped name second", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.searchParams.get("drugName") === "metformin"
        ? { rxclassDrugInfoList: { rxclassDrugInfo: [entry("metformin", "IN", "A10BA", "Biguanides")] } }
        : {},
    );
    const r = await createRxClassClassifier({ fetch: fn }).classify({ name: "metformin hydrochloride 500 MG Oral Tablet", rxcui: null });
    expect(calls.map((c) => new URL("http://x" + c).searchParams.get("drugName"))).toEqual(["metformin hydrochloride", "metformin"]);
    expect(r.tags).toEqual(["diabetes"]);
  });

  test("falls through from an empty byRxcui answer to the name", async () => {
    const { fn, calls } = fakeFetch((url) => (url.pathname.endsWith("byRxcui.json") ? {} : apixabanByRxcui));
    const r = await createRxClassClassifier({ fetch: fn }).classify({ name: "apixaban 5 MG Oral Tablet", rxcui: "999" });
    expect(calls.length).toBe(2);
    expect(r.tags).toEqual(["anticoagulant"]);
  });

  test("unknown drug is lookup none", async () => {
    const { fn } = fakeFetch(() => ({}));
    const r = await createRxClassClassifier({ fetch: fn }).classify({ name: "Zzzzmycin 10 MG Oral Tablet", rxcui: null });
    expect(r).toEqual({ tags: [], classes: [], lookup: "none", ingredient: "zzzzmycin" });
  });

  test("caches per rxcui and name", async () => {
    const { fn, calls } = fakeFetch(() => apixabanByRxcui);
    const c = createRxClassClassifier({ fetch: fn });
    await c.classify({ name: "apixaban 5 MG Oral Tablet", rxcui: "1364445" });
    await c.classify({ name: "apixaban 5 MG Oral Tablet", rxcui: "1364445" });
    expect(calls.length).toBe(1);
  });

  test("HTTP failure uses the built-in table", async () => {
    const { fn } = fakeFetch(() => new Response("oops", { status: 503 }));
    const c = createRxClassClassifier({ fetch: fn });
    const r = await c.classify({ name: "apixaban 5 MG Oral Tablet", rxcui: "1364445" });
    expect(r.lookup).toBe("local_fallback");
    expect(r.tags).toEqual(["anticoagulant"]);
    expect(r.classes[0]?.classId).toBe("B01AF");
  });

  test("network failure uses the built-in table, and stops retrying for a while", async () => {
    let n = 0;
    const fn = (async () => {
      n++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = createRxClassClassifier({ fetch: fn });
    const r1 = await c.classify({ name: "Aspirin 81 MG Oral Tablet", rxcui: null });
    const r2 = await c.classify({ name: "metformin hydrochloride 500 MG Oral Tablet", rxcui: "861007" });
    expect(r1.tags).toEqual(["antiplatelet"]);
    expect(r2.tags).toEqual(["diabetes"]);
    expect(n).toBe(1);
  });

  test("fallback covers the required drugs, and unknown drugs get no tags", async () => {
    const fn = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const c = createRxClassClassifier({ fetch: fn });
    const expected: Record<string, string> = {
      warfarin: "anticoagulant", apixaban: "anticoagulant", rivaroxaban: "anticoagulant", dabigatran: "anticoagulant",
      edoxaban: "anticoagulant", enoxaparin: "anticoagulant", heparin: "anticoagulant",
      aspirin: "antiplatelet", clopidogrel: "antiplatelet", prasugrel: "antiplatelet", ticagrelor: "antiplatelet",
      metformin: "diabetes", insulin: "diabetes", glipizide: "diabetes", glyburide: "diabetes", glimepiride: "diabetes",
      sitagliptin: "diabetes", empagliflozin: "diabetes", dapagliflozin: "diabetes", semaglutide: "diabetes", liraglutide: "diabetes",
    };
    for (const [drug, tag] of Object.entries(expected)) {
      const r = await c.classify({ name: `${drug} 10 MG Oral Tablet`, rxcui: null });
      expect(r.tags).toEqual([tag as never]);
    }
    const lisinopril = await c.classify({ name: "lisinopril 10 MG Oral Tablet", rxcui: null });
    expect(lisinopril).toEqual({ tags: [], classes: [], lookup: "local_fallback", ingredient: "lisinopril" });
  });
});
