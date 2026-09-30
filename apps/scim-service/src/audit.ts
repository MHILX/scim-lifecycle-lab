import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { LifecycleSyncOutcome } from "./auth0-adapter.js";

interface AuditContext {
  actor?: string;
  beforeState?: unknown;
  afterState?: unknown;
  adapterOutcome?: LifecycleSyncOutcome;
}

const auditContexts = new WeakMap<FastifyRequest, AuditContext>();
const defaultSensitiveAttributes = [
  "authorization",
  "access_token",
  "bearertoken",
  "client_secret",
  "clientsecret",
  "id_token",
  "password",
  "refresh_token",
  "secret",
  "token"
];

function getAuditContext(request: FastifyRequest): AuditContext {
  const existingContext = auditContexts.get(request);

  if (existingContext !== undefined) {
    return existingContext;
  }

  const context: AuditContext = {};
  auditContexts.set(request, context);
  return context;
}

export function markScimRequestAuthenticated(request: FastifyRequest): void {
  getAuditContext(request).actor = "scim-client";
}

export function setAuditSnapshots(
  request: FastifyRequest,
  beforeState: unknown | undefined,
  afterState: unknown | undefined
): void {
  const context = getAuditContext(request);
  context.beforeState = beforeState;
  context.afterState = afterState;
}

export function setAuditAdapterOutcome(request: FastifyRequest, outcome: LifecycleSyncOutcome): void {
  getAuditContext(request).adapterOutcome = outcome;
}

function isAuditEligibleRequest(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0] ?? request.url;
  return path !== "/health" && !path.startsWith("/_dev/");
}

function isSensitivePath(path: string, sensitiveAttributes: Set<string>): boolean {
  const normalizedPath = path.toLowerCase();
  const attributePath = normalizedPath.split("[", 1)[0] ?? normalizedPath;

  return (
    sensitiveAttributes.has(normalizedPath) ||
    attributePath.split(/[.:]/).some((attribute) => sensitiveAttributes.has(attribute))
  );
}

function redactValue(value: unknown, sensitiveAttributes: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, sensitiveAttributes));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const object = value as Record<string, unknown>;
  const sensitivePatchValue = typeof object.path === "string" && isSensitivePath(object.path, sensitiveAttributes);

  return Object.fromEntries(
    Object.entries(object).map(([key, nestedValue]) => [
      key,
      sensitiveAttributes.has(key.toLowerCase()) || (key.toLowerCase() === "value" && sensitivePatchValue)
        ? "[REDACTED]"
        : redactValue(nestedValue, sensitiveAttributes)
    ])
  );
}

function serializeForAudit(value: unknown | undefined, sensitiveAttributes: Set<string>): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(redactValue(value, sensitiveAttributes));
  } catch {
    return JSON.stringify("[Unserializable audit value]");
  }
}

export function registerAuditHooks(
  app: FastifyInstance,
  database: DatabaseSync,
  configuredSensitiveAttributes: string[] = []
): void {
  const sensitiveAttributes = new Set(
    [...defaultSensitiveAttributes, ...configuredSensitiveAttributes].map((attribute) => attribute.toLowerCase())
  );

  app.addHook("onResponse", async (request, reply) => {
    if (!isAuditEligibleRequest(request)) {
      return;
    }

    const auditContext = auditContexts.get(request);

    try {
      database
        .prepare(
          `
            INSERT INTO audit_events (
              id, correlation_id, actor, request_method, request_path, request_metadata,
              request_payload, http_status, before_state, after_state, adapter_outcome, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          randomUUID(),
          request.id,
          auditContext?.actor ?? "unauthenticated",
          request.method,
          request.url.split("?", 1)[0] ?? request.url,
          serializeForAudit(
            {
              contentType: request.headers["content-type"] ?? null,
              remoteAddress: request.ip
            },
            sensitiveAttributes
          ),
          serializeForAudit(request.body, sensitiveAttributes),
          reply.statusCode,
          serializeForAudit(auditContext?.beforeState, sensitiveAttributes),
          serializeForAudit(auditContext?.afterState, sensitiveAttributes),
          serializeForAudit(auditContext?.adapterOutcome, sensitiveAttributes),
          new Date().toISOString()
        );
    } catch (error) {
      request.log.error({ error }, "Unable to persist SCIM audit event");
    } finally {
      auditContexts.delete(request);
    }
  });
}
