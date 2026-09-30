import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  SCIM_CONTENT_TYPE,
  SCIM_GROUP_SCHEMA,
  SCIM_PATCH_OP_SCHEMA,
  ScimError,
  createScimListResponse,
  paginationQuerySchema,
  scimGroupInputSchema,
  scimGroupMemberSchema,
  scimPatchRequestSchema,
  type PaginationQuery,
  type ScimGroupInput,
  type ScimPatchRequest
} from "@scim-lifecycle-lab/scim-contract";

import { runInTransaction } from "./database/transaction.js";
import { setAuditSnapshots } from "./audit.js";
import { findStoredUser } from "./users.js";

interface GroupRow {
  id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface GroupMemberRow {
  id: string;
  user_name: string;
}

interface StoredGroup {
  id: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface GroupMutation {
  displayName: string;
  memberIds: string[];
}

const GROUP_COLUMNS = "id, display_name, created_at, updated_at, version";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapGroupRow(row: GroupRow): StoredGroup {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version
  };
}

function getGroupById(database: DatabaseSync, id: string): StoredGroup | undefined {
  const row = database.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE id = ?`).get(id) as GroupRow | undefined;

  return row === undefined ? undefined : mapGroupRow(row);
}

function getGroupByDisplayName(database: DatabaseSync, displayName: string): StoredGroup | undefined {
  const row = database
    .prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE display_name = ? COLLATE NOCASE`)
    .get(displayName) as GroupRow | undefined;

  return row === undefined ? undefined : mapGroupRow(row);
}

function getGroupMembers(database: DatabaseSync, groupId: string): GroupMemberRow[] {
  return database
    .prepare(
      `
        SELECT users.id, users.user_name
        FROM group_members
        INNER JOIN users ON users.id = group_members.user_id
        WHERE group_members.group_id = ?
        ORDER BY users.user_name, users.id
      `
    )
    .all(groupId) as unknown as GroupMemberRow[];
}

function assertGroupExists(database: DatabaseSync, id: string): StoredGroup {
  const group = getGroupById(database, id);

  if (group === undefined) {
    throw new ScimError(404, "Group was not found.");
  }

  return group;
}

function assertDisplayNameIsAvailable(database: DatabaseSync, displayName: string, existingId?: string): void {
  const existingGroup = getGroupByDisplayName(database, displayName);

  if (existingGroup !== undefined && existingGroup.id !== existingId) {
    throw new ScimError(409, "displayName already exists.", "uniqueness");
  }
}

function normalizeMemberIds(memberIds: string[]): string[] {
  return [...new Set(memberIds)];
}

function assertMemberUsersExist(database: DatabaseSync, memberIds: string[]): void {
  for (const memberId of memberIds) {
    if (findStoredUser(database, memberId) === undefined) {
      throw new ScimError(400, `Group member User '${memberId}' was not found.`, "invalidValue");
    }
  }
}

function groupInputToMutation(group: ScimGroupInput): GroupMutation {
  return {
    displayName: group.displayName,
    memberIds: normalizeMemberIds((group.members ?? []).map((member) => member.value))
  };
}

function replaceGroupMembers(database: DatabaseSync, groupId: string, memberIds: string[]): void {
  database.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
  const addMember = database.prepare(
    "INSERT INTO group_members (group_id, user_id, created_at) VALUES (?, ?, ?)"
  );
  const timestamp = new Date().toISOString();

  for (const memberId of memberIds) {
    addMember.run(groupId, memberId, timestamp);
  }
}

function haveSameMembers(existingMembers: GroupMemberRow[], memberIds: string[]): boolean {
  if (existingMembers.length !== memberIds.length) {
    return false;
  }

  const existingIds = new Set(existingMembers.map((member) => member.id));
  return memberIds.every((memberId) => existingIds.has(memberId));
}

function createStoredGroup(database: DatabaseSync, group: ScimGroupInput): StoredGroup {
  return runInTransaction(database, () => {
    const mutation = groupInputToMutation(group);
    assertDisplayNameIsAvailable(database, mutation.displayName);
    assertMemberUsersExist(database, mutation.memberIds);

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO groups (id, display_name, created_at, updated_at, version) VALUES (?, ?, ?, ?, 1)"
      )
      .run(id, mutation.displayName, timestamp, timestamp);
    replaceGroupMembers(database, id, mutation.memberIds);

    return assertGroupExists(database, id);
  });
}

function replaceStoredGroup(database: DatabaseSync, id: string, mutation: GroupMutation): StoredGroup {
  return runInTransaction(database, () => {
    const existingGroup = assertGroupExists(database, id);
    assertDisplayNameIsAvailable(database, mutation.displayName, id);
    assertMemberUsersExist(database, mutation.memberIds);

    const existingMembers = getGroupMembers(database, id);
    const membershipsChanged = !haveSameMembers(existingMembers, mutation.memberIds);
    const displayNameChanged = existingGroup.displayName !== mutation.displayName;

    if (!membershipsChanged && !displayNameChanged) {
      return existingGroup;
    }

    database
      .prepare(
        "UPDATE groups SET display_name = ?, updated_at = ?, version = version + 1 WHERE id = ?"
      )
      .run(mutation.displayName, new Date().toISOString(), id);

    if (membershipsChanged) {
      replaceGroupMembers(database, id, mutation.memberIds);
    }

    return assertGroupExists(database, id);
  });
}

function deleteStoredGroup(database: DatabaseSync, id: string): void {
  runInTransaction(database, () => {
    assertGroupExists(database, id);
    database.prepare("DELETE FROM groups WHERE id = ?").run(id);
  });
}

function parseDisplayNameFilter(filter: string | undefined): string | undefined {
  if (filter === undefined) {
    return undefined;
  }

  const match = /^displayName\s+eq\s+"((?:\\.|[^"\\])*)"$/i.exec(filter);
  const encodedValue = match?.[1];

  if (encodedValue === undefined) {
    throw new ScimError(400, 'Only filters in the form displayName eq "value" are supported.', "invalidFilter");
  }

  try {
    return JSON.parse(`"${encodedValue}"`) as string;
  } catch {
    throw new ScimError(400, "The filter contains an invalid string value.", "invalidFilter");
  }
}

function listStoredGroups(database: DatabaseSync, query: PaginationQuery): { groups: StoredGroup[]; totalResults: number } {
  const displayNameFilter = parseDisplayNameFilter(query.filter);
  const whereClause = displayNameFilter === undefined ? "" : " WHERE display_name = ? COLLATE NOCASE";
  const filterParameters = displayNameFilter === undefined ? [] : [displayNameFilter];
  const countRow = database
    .prepare(`SELECT COUNT(*) AS total FROM groups${whereClause}`)
    .get(...filterParameters) as unknown as { total: number };
  const offset = query.startIndex - 1;
  const rows =
    query.count === 0
      ? []
      : (database
          .prepare(`SELECT ${GROUP_COLUMNS} FROM groups${whereClause} ORDER BY created_at, id LIMIT ? OFFSET ?`)
          .all(...filterParameters, query.count, offset) as unknown as GroupRow[]);

  return {
    groups: rows.map(mapGroupRow),
    totalResults: countRow.total
  };
}

function validateGroupSchemas(group: ScimGroupInput): void {
  if (group.schemas === undefined) {
    return;
  }

  if (group.schemas.length !== 1 || group.schemas[0] !== SCIM_GROUP_SCHEMA) {
    throw new ScimError(400, "The Group resource declares an unsupported schema.", "invalidValue");
  }
}

function parseGroupInput(value: unknown): ScimGroupInput {
  const parsed = scimGroupInputSchema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "Invalid Group resource.";
    throw new ScimError(400, detail, "invalidValue");
  }

  validateGroupSchemas(parsed.data);
  return parsed.data;
}

function parseReplacementGroupInput(value: unknown, expectedId: string): ScimGroupInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScimError(400, "A Group resource object is required.", "invalidValue");
  }

  const { id, meta, ...attributes } = value as Record<string, unknown>;

  if (id !== undefined && id !== expectedId) {
    throw new ScimError(400, "The resource id does not match the request path.", "invalidValue");
  }

  if (meta !== undefined && (typeof meta !== "object" || meta === null || Array.isArray(meta))) {
    throw new ScimError(400, "meta must be an object when provided.", "invalidValue");
  }

  return parseGroupInput(attributes);
}

function parsePatchRequest(value: unknown): ScimPatchRequest {
  const parsed = scimPatchRequestSchema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "Invalid PATCH request.";
    throw new ScimError(400, detail, "invalidValue");
  }

  if (parsed.data.schemas !== undefined && !parsed.data.schemas.includes(SCIM_PATCH_OP_SCHEMA)) {
    throw new ScimError(400, "The PATCH request declares an unsupported schema.", "invalidValue");
  }

  return parsed.data;
}

function parsePatchMemberIds(value: unknown): string[] {
  const rawMembers = Array.isArray(value) ? value : [value];
  const memberIds: string[] = [];

  for (const rawMember of rawMembers) {
    const parsed = scimGroupMemberSchema.safeParse(rawMember);

    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? "Invalid Group member value.";
      throw new ScimError(400, detail, "invalidValue");
    }

    memberIds.push(parsed.data.value);
  }

  return normalizeMemberIds(memberIds);
}

function requirePatchValue(operation: ScimPatchRequest["Operations"][number]): unknown {
  if (operation.value === undefined) {
    throw new ScimError(400, "The PATCH operation requires a value.", "invalidValue");
  }

  return operation.value;
}

function applyGroupPatch(database: DatabaseSync, group: StoredGroup, patch: ScimPatchRequest): GroupMutation {
  let displayName = group.displayName;
  const memberIds = new Set(getGroupMembers(database, group.id).map((member) => member.id));

  for (const operation of patch.Operations) {
    const normalizedPath = operation.path?.toLowerCase();

    if (normalizedPath === undefined) {
      throw new ScimError(400, "PATCH operations must include a supported path.", "invalidPath");
    }

    if (normalizedPath === "displayname") {
      if (operation.op === "remove") {
        throw new ScimError(400, "displayName cannot be removed.", "mutability");
      }

      const value = requirePatchValue(operation);

      if (typeof value !== "string") {
        throw new ScimError(400, "displayName must be a string.", "invalidValue");
      }

      displayName = value;
      continue;
    }

    if (normalizedPath === "members") {
      const patchMemberIds = parsePatchMemberIds(requirePatchValue(operation));

      if (operation.op === "replace") {
        memberIds.clear();

        for (const memberId of patchMemberIds) {
          memberIds.add(memberId);
        }
      } else if (operation.op === "add") {
        for (const memberId of patchMemberIds) {
          memberIds.add(memberId);
        }
      } else {
        for (const memberId of patchMemberIds) {
          memberIds.delete(memberId);
        }
      }

      continue;
    }

    throw new ScimError(400, `The PATCH path '${operation.path}' is not supported.`, "invalidPath");
  }

  const candidate = scimGroupInputSchema.safeParse({
    displayName,
    members: [...memberIds].map((value) => ({ value }))
  });

  if (!candidate.success) {
    const detail = candidate.error.issues[0]?.message ?? "Invalid Group PATCH result.";
    throw new ScimError(400, detail, "invalidValue");
  }

  return groupInputToMutation(candidate.data);
}

function assertValidGroupId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new ScimError(400, "Group id must be a UUID.", "invalidValue");
  }
}

function groupLocation(request: FastifyRequest, id: string): string {
  return `${request.protocol}://${request.hostname}/Groups/${id}`;
}

function userLocation(request: FastifyRequest, id: string): string {
  return `${request.protocol}://${request.hostname}/Users/${id}`;
}

function toScimGroup(database: DatabaseSync, group: StoredGroup, request: FastifyRequest): Record<string, unknown> {
  const members = getGroupMembers(database, group.id).map((member) => ({
    value: member.id,
    "$ref": userLocation(request, member.id),
    display: member.user_name
  }));

  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    members,
    meta: {
      resourceType: "Group",
      created: group.createdAt,
      lastModified: group.updatedAt,
      location: groupLocation(request, group.id),
      version: `W/\"${group.version}\"`
    }
  };
}

function sendScim(reply: FastifyReply, statusCode: number, body?: unknown): FastifyReply {
  if (body === undefined) {
    return reply.code(statusCode).send();
  }

  return reply.code(statusCode).type(SCIM_CONTENT_TYPE).send(body);
}

export function registerGroupRoutes(app: FastifyInstance, database: DatabaseSync): void {
  app.get<{ Querystring: Record<string, unknown> }>("/Groups", async (request, reply) => {
    const parsedQuery = paginationQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      const detail = parsedQuery.error.issues[0]?.message ?? "Invalid pagination query.";
      throw new ScimError(400, detail, "invalidValue");
    }

    const result = listStoredGroups(database, parsedQuery.data);
    return sendScim(
      reply,
      200,
      createScimListResponse(
        result.groups.map((group) => toScimGroup(database, group, request)),
        result.totalResults,
        parsedQuery.data.startIndex
      )
    );
  });

  app.post<{ Body: unknown }>("/Groups", async (request, reply) => {
    setAuditSnapshots(request, null, undefined);
    const group = createStoredGroup(database, parseGroupInput(request.body));
    const location = groupLocation(request, group.id);
    const responseBody = toScimGroup(database, group, request);

    setAuditSnapshots(request, null, responseBody);

    reply.header("location", location);
    return sendScim(reply, 201, responseBody);
  });

  app.get<{ Params: { id: string } }>("/Groups/:id", async (request, reply) => {
    assertValidGroupId(request.params.id);
    const group = assertGroupExists(database, request.params.id);

    return sendScim(reply, 200, toScimGroup(database, group, request));
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/Groups/:id", async (request, reply) => {
    assertValidGroupId(request.params.id);
    const existingGroup = assertGroupExists(database, request.params.id);
    const beforeState = toScimGroup(database, existingGroup, request);
    setAuditSnapshots(request, beforeState, undefined);
    const replacement = groupInputToMutation(parseReplacementGroupInput(request.body, request.params.id));
    const group = replaceStoredGroup(database, request.params.id, replacement);
    const responseBody = toScimGroup(database, group, request);

    setAuditSnapshots(request, beforeState, responseBody);

    return sendScim(reply, 200, responseBody);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/Groups/:id", async (request, reply) => {
    assertValidGroupId(request.params.id);
    const existingGroup = assertGroupExists(database, request.params.id);
    const beforeState = toScimGroup(database, existingGroup, request);
    setAuditSnapshots(request, beforeState, undefined);
    const group = replaceStoredGroup(database, existingGroup.id, applyGroupPatch(database, existingGroup, parsePatchRequest(request.body)));
    const responseBody = toScimGroup(database, group, request);

    setAuditSnapshots(request, beforeState, responseBody);

    return sendScim(reply, 200, responseBody);
  });

  app.delete<{ Params: { id: string } }>("/Groups/:id", async (request, reply) => {
    assertValidGroupId(request.params.id);
    const group = assertGroupExists(database, request.params.id);
    setAuditSnapshots(request, toScimGroup(database, group, request), null);
    deleteStoredGroup(database, request.params.id);

    return sendScim(reply, 204);
  });
}
