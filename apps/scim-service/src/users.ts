import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  SCIM_CONTENT_TYPE,
  SCIM_ENTERPRISE_USER_SCHEMA,
  SCIM_PATCH_OP_SCHEMA,
  SCIM_USER_SCHEMA,
  ScimError,
  createScimListResponse,
  paginationQuerySchema,
  scimPatchRequestSchema,
  scimUserInputSchema,
  type PaginationQuery,
  type ScimPatchRequest,
  type ScimUserInput
} from "@scim-lifecycle-lab/scim-contract";

import { runInTransaction } from "./database/transaction.js";
import { setAuditSnapshots } from "./audit.js";

interface UserRow {
  id: string;
  external_id: string | null;
  user_name: string;
  given_name: string | null;
  family_name: string | null;
  display_name: string | null;
  department: string | null;
  employee_number: string | null;
  email: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface AffectedGroupRow {
  id: string;
  display_name: string;
}

export interface StoredUser {
  id: string;
  externalId: string | null;
  userName: string;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  department: string | null;
  employeeNumber: string | null;
  email: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

const USER_COLUMNS = `
  id,
  external_id,
  user_name,
  given_name,
  family_name,
  display_name,
  department,
  employee_number,
  email,
  active,
  created_at,
  updated_at,
  version
`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapUserRow(row: UserRow): StoredUser {
  return {
    id: row.id,
    externalId: row.external_id,
    userName: row.user_name,
    givenName: row.given_name,
    familyName: row.family_name,
    displayName: row.display_name,
    department: row.department,
    employeeNumber: row.employee_number,
    email: row.email,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version
  };
}

function getUserById(database: DatabaseSync, id: string): StoredUser | undefined {
  const row = database
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(id) as UserRow | undefined;

  return row === undefined ? undefined : mapUserRow(row);
}

export function findStoredUser(database: DatabaseSync, id: string): StoredUser | undefined {
  return getUserById(database, id);
}

function getUserByUserName(database: DatabaseSync, userName: string): StoredUser | undefined {
  const row = database
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE user_name = ? COLLATE NOCASE`)
    .get(userName) as UserRow | undefined;

  return row === undefined ? undefined : mapUserRow(row);
}

function getUserByExternalId(database: DatabaseSync, externalId: string): StoredUser | undefined {
  const row = database
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE external_id = ?`)
    .get(externalId) as UserRow | undefined;

  return row === undefined ? undefined : mapUserRow(row);
}

function userInputToColumns(user: ScimUserInput): {
  externalId: string | null;
  userName: string;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  department: string | null;
  employeeNumber: string | null;
  email: string | null;
  active: number;
} {
  const enterpriseAttributes = user[SCIM_ENTERPRISE_USER_SCHEMA];
  const primaryEmail = user.emails?.find((email) => email.primary === true) ?? user.emails?.[0];

  return {
    externalId: user.externalId ?? null,
    userName: user.userName,
    givenName: user.name?.givenName ?? null,
    familyName: user.name?.familyName ?? null,
    displayName: user.displayName ?? null,
    department: enterpriseAttributes?.department ?? null,
    employeeNumber: enterpriseAttributes?.employeeNumber ?? null,
    email: primaryEmail?.value ?? null,
    active: user.active ? 1 : 0
  };
}

function assertUserNameIsAvailable(database: DatabaseSync, userName: string, existingId?: string): void {
  const existingUser = getUserByUserName(database, userName);

  if (existingUser !== undefined && existingUser.id !== existingId) {
    throw new ScimError(409, "userName already exists.", "uniqueness");
  }
}

function assertExternalIdIsAvailable(database: DatabaseSync, externalId: string | null, existingId?: string): void {
  if (externalId === null) {
    return;
  }

  const existingUser = getUserByExternalId(database, externalId);

  if (existingUser !== undefined && existingUser.id !== existingId) {
    throw new ScimError(409, "externalId already exists.", "uniqueness");
  }
}

function assertUserExists(database: DatabaseSync, id: string): StoredUser {
  const user = getUserById(database, id);

  if (user === undefined) {
    throw new ScimError(404, "User was not found.");
  }

  return user;
}

function createStoredUser(database: DatabaseSync, user: ScimUserInput): StoredUser {
  return runInTransaction(database, () => {
    assertUserNameIsAvailable(database, user.userName);
    assertExternalIdIsAvailable(database, user.externalId ?? null);

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const columns = userInputToColumns(user);

    database
      .prepare(
        `
          INSERT INTO users (
            id, external_id, user_name, given_name, family_name, display_name,
            department, employee_number, email, active, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `
      )
      .run(
        id,
        columns.externalId,
        columns.userName,
        columns.givenName,
        columns.familyName,
        columns.displayName,
        columns.department,
        columns.employeeNumber,
        columns.email,
        columns.active,
        timestamp,
        timestamp
      );

    return assertUserExists(database, id);
  });
}

function replaceStoredUser(database: DatabaseSync, id: string, user: ScimUserInput): StoredUser {
  return runInTransaction(database, () => {
    assertUserExists(database, id);
    assertUserNameIsAvailable(database, user.userName, id);
    assertExternalIdIsAvailable(database, user.externalId ?? null, id);

    const columns = userInputToColumns(user);
    database
      .prepare(
        `
          UPDATE users
          SET
            external_id = ?,
            user_name = ?,
            given_name = ?,
            family_name = ?,
            display_name = ?,
            department = ?,
            employee_number = ?,
            email = ?,
            active = ?,
            updated_at = ?,
            version = version + 1
          WHERE id = ?
        `
      )
      .run(
        columns.externalId,
        columns.userName,
        columns.givenName,
        columns.familyName,
        columns.displayName,
        columns.department,
        columns.employeeNumber,
        columns.email,
        columns.active,
        new Date().toISOString(),
        id
      );

    return assertUserExists(database, id);
  });
}

function deleteStoredUser(database: DatabaseSync, id: string): Array<{ id: string; displayName: string }> {
  return runInTransaction(database, () => {
    assertUserExists(database, id);
    const affectedGroups = database
      .prepare(
        `
          SELECT groups.id, groups.display_name
          FROM groups
          INNER JOIN group_members ON group_members.group_id = groups.id
          WHERE group_members.user_id = ?
          ORDER BY groups.display_name, groups.id
        `
      )
      .all(id) as unknown as AffectedGroupRow[];

    database.prepare("DELETE FROM users WHERE id = ?").run(id);

    if (affectedGroups.length > 0) {
      const placeholders = affectedGroups.map(() => "?").join(", ");
      database
        .prepare(
          `UPDATE groups SET updated_at = ?, version = version + 1 WHERE id IN (${placeholders})`
        )
        .run(new Date().toISOString(), ...affectedGroups.map((group) => group.id));
    }

    return affectedGroups.map((group) => ({ id: group.id, displayName: group.display_name }));
  });
}

function parseUserFilter(filter: string | undefined): { column: "user_name" | "external_id"; value: string } | undefined {
  if (filter === undefined) {
    return undefined;
  }

  const match = /^(userName|externalId)\s+eq\s+"((?:\\.|[^"\\])*)"$/i.exec(filter);
  const attribute = match?.[1]?.toLowerCase();
  const encodedValue = match?.[2];

  if (attribute === undefined || encodedValue === undefined) {
    throw new ScimError(
      400,
      'Only filters in the form userName eq "value" or externalId eq "value" are supported.',
      "invalidFilter"
    );
  }

  try {
    return {
      column: attribute === "username" ? "user_name" : "external_id",
      value: JSON.parse(`"${encodedValue}"`) as string
    };
  } catch {
    throw new ScimError(400, "The filter contains an invalid string value.", "invalidFilter");
  }
}

function listStoredUsers(database: DatabaseSync, query: PaginationQuery): { users: StoredUser[]; totalResults: number } {
  const userFilter = parseUserFilter(query.filter);
  const whereClause =
    userFilter === undefined
      ? ""
      : userFilter.column === "user_name"
        ? " WHERE user_name = ? COLLATE NOCASE"
        : " WHERE external_id = ?";
  const filterParameters = userFilter === undefined ? [] : [userFilter.value];
  const countRow = database
    .prepare(`SELECT COUNT(*) AS total FROM users${whereClause}`)
    .get(...filterParameters) as { total: number };
  const offset = query.startIndex - 1;
  const rows =
    query.count === 0
      ? []
      : (database
          .prepare(`SELECT ${USER_COLUMNS} FROM users${whereClause} ORDER BY created_at, id LIMIT ? OFFSET ?`)
          .all(...filterParameters, query.count, offset) as unknown as UserRow[]);

  return {
    users: rows.map(mapUserRow),
    totalResults: countRow.total
  };
}

function validateUserSchemas(user: ScimUserInput): void {
  if (user.schemas === undefined) {
    return;
  }

  const supportedSchemas = new Set([SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA]);
  const hasUnsupportedSchema = user.schemas.some((schema) => !supportedSchemas.has(schema));

  if (!user.schemas.includes(SCIM_USER_SCHEMA) || hasUnsupportedSchema) {
    throw new ScimError(400, "The User resource declares an unsupported schema.", "invalidValue");
  }

  if (user[SCIM_ENTERPRISE_USER_SCHEMA] !== undefined && !user.schemas.includes(SCIM_ENTERPRISE_USER_SCHEMA)) {
    throw new ScimError(400, "Enterprise attributes require the enterprise User schema.", "invalidValue");
  }
}

function parseUserInput(value: unknown): ScimUserInput {
  const parsed = scimUserInputSchema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "Invalid User resource.";
    throw new ScimError(400, detail, "invalidValue");
  }

  validateUserSchemas(parsed.data);
  return parsed.data;
}

function parseReplacementUserInput(value: unknown, expectedId: string): ScimUserInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScimError(400, "A User resource object is required.", "invalidValue");
  }

  const { id, meta, ...attributes } = value as Record<string, unknown>;

  if (id !== undefined && id !== expectedId) {
    throw new ScimError(400, "The resource id does not match the request path.", "invalidValue");
  }

  if (meta !== undefined && (typeof meta !== "object" || meta === null || Array.isArray(meta))) {
    throw new ScimError(400, "meta must be an object when provided.", "invalidValue");
  }

  return parseUserInput(attributes);
}

function userToInput(user: StoredUser): ScimUserInput {
  const input: ScimUserInput = {
    userName: user.userName,
    active: user.active
  };

  if (user.externalId !== null) {
    input.externalId = user.externalId;
  }

  if (user.givenName !== null || user.familyName !== null) {
    input.name = {
      ...(user.givenName === null ? {} : { givenName: user.givenName }),
      ...(user.familyName === null ? {} : { familyName: user.familyName })
    };
  }

  if (user.displayName !== null) {
    input.displayName = user.displayName;
  }

  if (user.email !== null) {
    input.emails = [{ value: user.email, primary: true }];
  }

  if (user.department !== null || user.employeeNumber !== null) {
    input[SCIM_ENTERPRISE_USER_SCHEMA] = {
      ...(user.department === null ? {} : { department: user.department }),
      ...(user.employeeNumber === null ? {} : { employeeNumber: user.employeeNumber })
    };
  }

  return input;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requirePatchValue(operation: ScimPatchRequest["Operations"][number]): unknown {
  if (operation.value === undefined) {
    throw new ScimError(400, "add and replace operations require a value.", "invalidValue");
  }

  return operation.value;
}

function updatePatchAttribute(candidate: Record<string, unknown>, path: string, value: unknown): void {
  const normalizedPath = path.toLowerCase();
  const enterprisePrefix = `${SCIM_ENTERPRISE_USER_SCHEMA}:`.toLowerCase();

  if (normalizedPath === "username") {
    candidate.userName = value;
    return;
  }

  if (normalizedPath === "externalid") {
    candidate.externalId = value;
    return;
  }

  if (normalizedPath === "displayname") {
    candidate.displayName = value;
    return;
  }

  if (normalizedPath === "active") {
    candidate.active = value;
    return;
  }

  if (normalizedPath === "emails") {
    candidate.emails = value;
    return;
  }

  if (normalizedPath === "name") {
    candidate.name = value;
    return;
  }

  if (normalizedPath === "name.givenname" || normalizedPath === "name.familyname") {
    const name = asObject(candidate.name) ?? {};
    name[normalizedPath === "name.givenname" ? "givenName" : "familyName"] = value;
    candidate.name = name;
    return;
  }

  if (normalizedPath.startsWith(enterprisePrefix)) {
    const attribute = normalizedPath.slice(enterprisePrefix.length);
    const enterpriseAttributes = asObject(candidate[SCIM_ENTERPRISE_USER_SCHEMA]) ?? {};

    if (attribute !== "department" && attribute !== "employeenumber") {
      throw new ScimError(400, `The PATCH path '${path}' is not supported.`, "invalidPath");
    }

    enterpriseAttributes[attribute === "department" ? "department" : "employeeNumber"] = value;
    candidate[SCIM_ENTERPRISE_USER_SCHEMA] = enterpriseAttributes;
    return;
  }

  throw new ScimError(400, `The PATCH path '${path}' is not supported.`, "invalidPath");
}

function removePatchAttribute(candidate: Record<string, unknown>, path: string): void {
  const normalizedPath = path.toLowerCase();
  const enterprisePrefix = `${SCIM_ENTERPRISE_USER_SCHEMA}:`.toLowerCase();

  if (normalizedPath === "username" || normalizedPath === "active") {
    throw new ScimError(400, `The PATCH path '${path}' cannot be removed.`, "mutability");
  }

  if (normalizedPath === "externalid" || normalizedPath === "displayname" || normalizedPath === "emails") {
    delete candidate[normalizedPath === "externalid" ? "externalId" : normalizedPath === "displayname" ? "displayName" : "emails"];
    return;
  }

  if (normalizedPath === "name") {
    delete candidate.name;
    return;
  }

  if (normalizedPath === "name.givenname" || normalizedPath === "name.familyname") {
    const name = asObject(candidate.name);

    if (name === undefined) {
      throw new ScimError(400, `The PATCH path '${path}' has no target.`, "noTarget");
    }

    delete name[normalizedPath === "name.givenname" ? "givenName" : "familyName"];

    if (Object.keys(name).length === 0) {
      delete candidate.name;
    }

    return;
  }

  if (normalizedPath.startsWith(enterprisePrefix)) {
    const attribute = normalizedPath.slice(enterprisePrefix.length);
    const enterpriseAttributes = asObject(candidate[SCIM_ENTERPRISE_USER_SCHEMA]);

    if (attribute !== "department" && attribute !== "employeenumber") {
      throw new ScimError(400, `The PATCH path '${path}' is not supported.`, "invalidPath");
    }

    if (enterpriseAttributes === undefined) {
      throw new ScimError(400, `The PATCH path '${path}' has no target.`, "noTarget");
    }

    delete enterpriseAttributes[attribute === "department" ? "department" : "employeeNumber"];

    if (Object.keys(enterpriseAttributes).length === 0) {
      delete candidate[SCIM_ENTERPRISE_USER_SCHEMA];
    }

    return;
  }

  throw new ScimError(400, `The PATCH path '${path}' is not supported.`, "invalidPath");
}

function applyUserPatch(existingUser: StoredUser, patch: ScimPatchRequest): ScimUserInput {
  if (patch.schemas !== undefined && !patch.schemas.includes(SCIM_PATCH_OP_SCHEMA)) {
    throw new ScimError(400, "The PATCH request declares an unsupported schema.", "invalidValue");
  }

  const candidate = structuredClone(userToInput(existingUser)) as Record<string, unknown>;

  for (const operation of patch.Operations) {
    if (operation.path === undefined) {
      throw new ScimError(400, "PATCH operations must include a supported path.", "invalidPath");
    }

    if (operation.op === "remove") {
      removePatchAttribute(candidate, operation.path);
    } else {
      updatePatchAttribute(candidate, operation.path, requirePatchValue(operation));
    }
  }

  return parseUserInput(candidate);
}

function parsePatchRequest(value: unknown): ScimPatchRequest {
  const parsed = scimPatchRequestSchema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "Invalid PATCH request.";
    throw new ScimError(400, detail, "invalidValue");
  }

  return parsed.data;
}

function assertValidUserId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new ScimError(400, "User id must be a UUID.", "invalidValue");
  }
}

function userLocation(request: FastifyRequest, id: string): string {
  return `${request.protocol}://${request.hostname}/Users/${id}`;
}

function toScimUser(user: StoredUser, request: FastifyRequest): Record<string, unknown> {
  const hasEnterpriseAttributes = user.department !== null || user.employeeNumber !== null;
  const enterpriseAttributes = {
    ...(user.department === null ? {} : { department: user.department }),
    ...(user.employeeNumber === null ? {} : { employeeNumber: user.employeeNumber })
  };

  return {
    schemas: [SCIM_USER_SCHEMA, ...(hasEnterpriseAttributes ? [SCIM_ENTERPRISE_USER_SCHEMA] : [])],
    id: user.id,
    ...(user.externalId === null ? {} : { externalId: user.externalId }),
    userName: user.userName,
    ...(user.givenName === null && user.familyName === null
      ? {}
      : {
          name: {
            ...(user.givenName === null ? {} : { givenName: user.givenName }),
            ...(user.familyName === null ? {} : { familyName: user.familyName })
          }
        }),
    ...(user.displayName === null ? {} : { displayName: user.displayName }),
    ...(user.email === null ? {} : { emails: [{ value: user.email, primary: true }] }),
    active: user.active,
    ...(hasEnterpriseAttributes ? { [SCIM_ENTERPRISE_USER_SCHEMA]: enterpriseAttributes } : {}),
    meta: {
      resourceType: "User",
      created: user.createdAt,
      lastModified: user.updatedAt,
      location: userLocation(request, user.id),
      version: `W/\"${user.version}\"`
    }
  };
}

function sendScim(reply: FastifyReply, statusCode: number, body?: unknown): FastifyReply {
  if (body === undefined) {
    return reply.code(statusCode).send();
  }

  return reply.code(statusCode).type(SCIM_CONTENT_TYPE).send(body);
}

export function registerUserRoutes(app: FastifyInstance, database: DatabaseSync): void {
  app.get<{ Querystring: Record<string, unknown> }>("/Users", async (request, reply) => {
    const parsedQuery = paginationQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      const detail = parsedQuery.error.issues[0]?.message ?? "Invalid pagination query.";
      throw new ScimError(400, detail, "invalidValue");
    }

    const result = listStoredUsers(database, parsedQuery.data);
    return sendScim(
      reply,
      200,
      createScimListResponse(
        result.users.map((user) => toScimUser(user, request)),
        result.totalResults,
        parsedQuery.data.startIndex
      )
    );
  });

  app.post<{ Body: unknown }>("/Users", async (request, reply) => {
    setAuditSnapshots(request, null, undefined);
    const user = createStoredUser(database, parseUserInput(request.body));
    const location = userLocation(request, user.id);
    const responseBody = toScimUser(user, request);

    setAuditSnapshots(request, null, responseBody);

    reply.header("location", location);
    return sendScim(reply, 201, responseBody);
  });

  app.get<{ Params: { id: string } }>("/Users/:id", async (request, reply) => {
    assertValidUserId(request.params.id);
    const user = assertUserExists(database, request.params.id);

    return sendScim(reply, 200, toScimUser(user, request));
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/Users/:id", async (request, reply) => {
    assertValidUserId(request.params.id);
    const existingUser = assertUserExists(database, request.params.id);
    const beforeState = toScimUser(existingUser, request);
    setAuditSnapshots(request, beforeState, undefined);
    const user = replaceStoredUser(
      database,
      request.params.id,
      parseReplacementUserInput(request.body, request.params.id)
    );
    const responseBody = toScimUser(user, request);

    setAuditSnapshots(request, beforeState, responseBody);

    return sendScim(reply, 200, responseBody);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/Users/:id", async (request, reply) => {
    assertValidUserId(request.params.id);
    const existingUser = assertUserExists(database, request.params.id);
    const beforeState = toScimUser(existingUser, request);
    setAuditSnapshots(request, beforeState, undefined);
    const user = replaceStoredUser(database, existingUser.id, applyUserPatch(existingUser, parsePatchRequest(request.body)));
    const responseBody = toScimUser(user, request);

    setAuditSnapshots(request, beforeState, responseBody);

    return sendScim(reply, 200, responseBody);
  });

  app.delete<{ Params: { id: string } }>("/Users/:id", async (request, reply) => {
    assertValidUserId(request.params.id);
    const user = assertUserExists(database, request.params.id);
    const beforeState = toScimUser(user, request);
    setAuditSnapshots(request, beforeState, undefined);
    const affectedGroups = deleteStoredUser(database, request.params.id);
    setAuditSnapshots(request, beforeState, { deletedUserId: user.id, removedFromGroups: affectedGroups });

    return sendScim(reply, 204);
  });
}
