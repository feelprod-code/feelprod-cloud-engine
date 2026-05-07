import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_aaiybvsxgqmxfzqbkggg",
  runtime: "node",
  logLevel: "log",
  // 1 heure max pour les longs batchs de texte
  maxDuration: 3600, 
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["src/trigger"],
});
