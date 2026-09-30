import { existsSync } from "node:fs";

import { createScimApp } from "./app.js";
import { createAuth0LifecycleAdapter } from "./auth0-adapter.js";
import { loadServiceConfig } from "./config.js";
import { openDatabase } from "./database/connection.js";

async function main(): Promise<void> {
  const environmentFile = existsSync(".env") ? ".env" : new URL("../../../.env", import.meta.url);

  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }

  const config = loadServiceConfig();
  const database = openDatabase(config.databasePath);
  const lifecycleAdapter = createAuth0LifecycleAdapter(config.auth0Management);

  const app = createScimApp({
    bearerToken: config.bearerToken,
    database,
    enforceHttps: config.enforceHttps,
    trustedProxies: config.trustedProxies,
    enableInspection: config.enableInspection,
    auditRedactAttributes: config.auditRedactAttributes,
    ...(lifecycleAdapter === undefined ? {} : { lifecycleAdapter }),
    logger: { level: config.logLevel }
  });

  app.addHook("onClose", async () => {
    database.close();
  });

  try {
    const address = await app.listen({ host: config.host, port: config.port });
    app.log.info({ address }, "SCIM service listening");
  } catch (error) {
    app.log.error({ error }, "SCIM service failed to start");
    await app.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
