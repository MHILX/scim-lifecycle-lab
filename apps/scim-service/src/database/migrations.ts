import type { DatabaseSync } from "node:sqlite";

interface Migration {
  id: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    id: "001_initial_schema",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,
        external_id TEXT UNIQUE,
        user_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        given_name TEXT,
        family_name TEXT,
        display_name TEXT,
        department TEXT,
        employee_number TEXT,
        email TEXT,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      );

      CREATE TABLE groups (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      );

      CREATE TABLE group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        correlation_id TEXT NOT NULL,
        actor TEXT,
        request_method TEXT NOT NULL,
        request_path TEXT NOT NULL,
        request_metadata TEXT,
        request_payload TEXT,
        http_status INTEGER NOT NULL,
        before_state TEXT,
        after_state TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_users_active ON users(active);
      CREATE INDEX idx_group_members_user_id ON group_members(user_id);
      CREATE INDEX idx_audit_events_correlation_id ON audit_events(correlation_id);
      CREATE INDEX idx_audit_events_created_at ON audit_events(created_at);
    `
  },
  {
    id: "002_users_external_id_index",
    sql: "CREATE INDEX idx_users_external_id ON users(external_id);"
  }
];

export function migrateDatabase(database: DatabaseSync): string[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  const appliedIds = new Set(appliedRows.map((row) => row.id));
  const pendingMigrations = migrations.filter((migration) => !appliedIds.has(migration.id));

  if (pendingMigrations.length === 0) {
    return [];
  }

  database.exec("BEGIN IMMEDIATE;");

  try {
    const recordMigration = database.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
    );

    for (const migration of pendingMigrations) {
      database.exec(migration.sql);
      recordMigration.run(migration.id, new Date().toISOString());
    }

    database.exec("COMMIT;");
    return pendingMigrations.map((migration) => migration.id);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
