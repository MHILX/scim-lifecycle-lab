import { existsSync } from "node:fs";

import { loadServiceConfig } from "../config.js";
import { openDatabase } from "./connection.js";
import { migrateDatabase } from "./migrations.js";

function main(): void {
  const environmentFile = existsSync(".env") ? ".env" : new URL("../../../../.env", import.meta.url);

  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }

  const config = loadServiceConfig();
  const database = openDatabase(config.databasePath);

  try {
    const appliedMigrations = migrateDatabase(database);
    const result = appliedMigrations.length === 0 ? "No pending migrations." : appliedMigrations.join(", ");
    console.log(`Migration complete: ${result}`);
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
