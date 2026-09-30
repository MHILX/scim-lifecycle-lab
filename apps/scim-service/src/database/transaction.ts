import type { DatabaseSync } from "node:sqlite";

export function runInTransaction<Value>(database: DatabaseSync, operation: () => Value): Value {
  database.exec("BEGIN IMMEDIATE;");

  try {
    const value = operation();
    database.exec("COMMIT;");
    return value;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
