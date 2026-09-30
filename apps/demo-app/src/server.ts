import { existsSync } from "node:fs";

import { createDemoApp } from "./app.js";
import { createAuth0Authentication } from "./authentication.js";
import { loadDemoAppConfig } from "./config.js";
import { HttpScimDirectoryClient } from "./scim-client.js";

async function main(): Promise<void> {
  const environmentFile = existsSync(".env") ? ".env" : new URL("../../../.env", import.meta.url);

  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }

  const config = loadDemoAppConfig();
  const app = createDemoApp({
    authentication: createAuth0Authentication(config),
    directoryClient: new HttpScimDirectoryClient(config.scimBaseUrl, config.scimBearerToken)
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      console.log(`Demo app listening at ${config.baseUrl}`);
      resolve();
    });
    server.on("error", reject);
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
