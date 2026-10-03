import { createBridge } from "./bridge.ts";
import { createSpectrumTransport } from "./spectrum.ts";

const env = process.env;

for (const name of ["PROJECT_ID", "PROJECT_SECRET"] as const) {
  if (!env[name]?.trim()) {
    console.error(`Missing environment variable ${name}. Get the project id and secret from https://app.photon.codes and set both before running the iMessage adapter.`);
    process.exit(1);
  }
}

const coreUrl = env.CORE_URL?.trim() || "http://localhost:8787";
const clinic = {
  name: env.CLINIC_NAME?.trim() || "Northstar Surgical Center",
  phone: env.CLINIC_PHONE?.trim() || "(734) 555-0100",
};

const bridge = createBridge({
  transport: createSpectrumTransport({ projectId: env.PROJECT_ID!.trim(), projectSecret: env.PROJECT_SECRET!.trim() }),
  coreUrl,
  clinic,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});

const shutdown = () => {
  void bridge.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`iMessage adapter starting. Core at ${coreUrl}.`);
await bridge.start();
