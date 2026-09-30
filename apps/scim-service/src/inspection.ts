import type { DatabaseSync } from "node:sqlite";

import type { FastifyInstance } from "fastify";

interface InspectionUserRow {
  id: string;
  external_id: string | null;
  user_name: string;
  display_name: string | null;
  department: string | null;
  employee_number: string | null;
  email: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface InspectionGroupRow {
  id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface InspectionMemberRow {
  id: string;
  user_name: string;
}

interface InspectionAuditRow {
  id: string;
  correlation_id: string;
  actor: string | null;
  request_method: string;
  request_path: string;
  request_metadata: string | null;
  request_payload: string | null;
  http_status: number;
  before_state: string | null;
  after_state: string | null;
  created_at: string;
}

function parseAuditJson(value: string | null): unknown | null {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return "[Unreadable audit value]";
  }
}

export function registerInspectionRoute(app: FastifyInstance, database: DatabaseSync): void {
  app.get("/_dev/inspection", async (_request, reply) => {
    const users = database
      .prepare(
        `
          SELECT id, external_id, user_name, display_name, department, employee_number, email,
                 active, created_at, updated_at, version
          FROM users
          ORDER BY created_at, id
        `
      )
      .all() as unknown as InspectionUserRow[];
    const groups = database
      .prepare("SELECT id, display_name, created_at, updated_at, version FROM groups ORDER BY created_at, id")
      .all() as unknown as InspectionGroupRow[];
    const groupMembers = database.prepare(
      `
        SELECT group_members.group_id, users.id, users.user_name
        FROM group_members
        INNER JOIN users ON users.id = group_members.user_id
        WHERE group_members.group_id = ?
        ORDER BY users.user_name, users.id
      `
    );
    const auditEvents = database
      .prepare(
        `
          SELECT id, correlation_id, actor, request_method, request_path, request_metadata,
                 request_payload, http_status, before_state, after_state, created_at
          FROM audit_events
          ORDER BY created_at DESC, id DESC
          LIMIT 500
        `
      )
      .all() as unknown as InspectionAuditRow[];

    return reply.type("application/json").send({
      users: users.map((user) => ({
        id: user.id,
        externalId: user.external_id,
        userName: user.user_name,
        displayName: user.display_name,
        department: user.department,
        employeeNumber: user.employee_number,
        email: user.email,
        active: user.active === 1,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        version: user.version
      })),
      groups: groups.map((group) => ({
        id: group.id,
        displayName: group.display_name,
        members: (
          groupMembers.all(group.id) as unknown as Array<InspectionMemberRow & { group_id: string }>
        ).map((member) => ({ id: member.id, userName: member.user_name })),
        createdAt: group.created_at,
        updatedAt: group.updated_at,
        version: group.version
      })),
      auditEvents: auditEvents.map((event) => ({
        id: event.id,
        correlationId: event.correlation_id,
        actor: event.actor,
        method: event.request_method,
        path: event.request_path,
        requestMetadata: parseAuditJson(event.request_metadata),
        requestPayload: parseAuditJson(event.request_payload),
        status: event.http_status,
        beforeState: parseAuditJson(event.before_state),
        afterState: parseAuditJson(event.after_state),
        createdAt: event.created_at
      }))
    });
  });
}
