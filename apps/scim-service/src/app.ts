import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  SCIM_CONTENT_TYPE,
  ScimError,
  createScimListResponse,
  groupSchema,
  resourceTypes,
  schemas,
  serviceProviderConfig,
  userSchema
} from "@scim-lifecycle-lab/scim-contract";

import { markScimRequestAuthenticated, registerAuditHooks } from "./audit.js";
import { migrateDatabase } from "./database/migrations.js";
import { registerGroupRoutes } from "./groups.js";
import { registerInspectionRoute } from "./inspection.js";
import { registerUserRoutes } from "./users.js";

export interface ScimAppOptions {
  bearerToken: string;
  database?: DatabaseSync;
  bodyLimit?: number;
  enforceHttps?: boolean;
  enableInspection?: boolean;
  auditRedactAttributes?: string[];
  logger?: boolean | { level: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent" };
}

function tokensMatch(presentedToken: string, expectedToken: string): boolean {
  const presented = Buffer.from(presentedToken);
  const expected = Buffer.from(expectedToken);

  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function sendScim(reply: FastifyReply, statusCode: number, body: unknown): FastifyReply {
  return reply.code(statusCode).type(SCIM_CONTENT_TYPE).send(body);
}

export function createScimApp(options: ScimAppOptions): FastifyInstance {
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(database);

  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: "x-correlation-id",
    bodyLimit: options.bodyLimit ?? 1_048_576
  });

  app.addContentTypeParser(/^application\/scim\+json(?:\s*;.*)?$/i, { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new ScimError(400, "The SCIM request body must contain valid JSON.", "invalidSyntax"));
    }
  });

  const protectScimEndpoint = async (request: FastifyRequest): Promise<void> => {
    if (options.enforceHttps === true && request.protocol !== "https") {
      throw new ScimError(403, "HTTPS is required for SCIM endpoints.");
    }

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
    const presentedToken = bearerMatch?.[1];

    if (presentedToken === undefined || !tokensMatch(presentedToken, options.bearerToken)) {
      throw new ScimError(401, "A valid bearer token is required.");
    }

    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      const contentType = request.headers["content-type"];

      if (typeof contentType !== "string" || !/^application\/scim\+json(?:\s*;.*)?$/i.test(contentType)) {
        throw new ScimError(415, "SCIM request content type must be application/scim+json.");
      }
    }

    markScimRequestAuthenticated(request);
  };

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-correlation-id", request.id);
    return payload;
  });

  app.addHook("onClose", async () => {
    if (ownsDatabase) {
      database.close();
    }
  });

  registerAuditHooks(app, database, options.auditRedactAttributes);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ScimError) {
      return sendScim(reply, error.statusCode, error.toPayload());
    }

    const errorCode =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;

    if (errorCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return sendScim(reply, 415, new ScimError(415, "Unsupported request content type.").toPayload());
    }

    if (errorCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendScim(reply, 413, new ScimError(413, "SCIM request body exceeds the configured size limit.").toPayload());
    }

    request.log.error({ error }, "Unhandled SCIM service error");
    return sendScim(reply, 500, new ScimError(500, "An internal server error occurred.").toPayload());
  });

  app.setNotFoundHandler((request, reply) => {
    return sendScim(reply, 404, new ScimError(404, "Resource was not found.").toPayload());
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.register((scim, _options, done) => {
    scim.addHook("onRequest", protectScimEndpoint);

    scim.get("/ServiceProviderConfig", async (_request, reply) => sendScim(reply, 200, serviceProviderConfig));

    scim.get("/ResourceTypes", async (_request, reply) =>
      sendScim(reply, 200, createScimListResponse([...resourceTypes], resourceTypes.length, 1))
    );

    scim.get<{ Params: { id: string } }>("/ResourceTypes/:id", async (request, reply) => {
      const resourceType = resourceTypes.find((candidate) => candidate.id === request.params.id);

      if (resourceType === undefined) {
        throw new ScimError(404, `Resource type '${request.params.id}' was not found.`);
      }

      return sendScim(reply, 200, resourceType);
    });

    scim.get("/Schemas", async (_request, reply) =>
      sendScim(reply, 200, createScimListResponse([...schemas], schemas.length, 1))
    );

    scim.get<{ Params: { id: string } }>("/Schemas/:id", async (request, reply) => {
      const schema = schemas.find((candidate) => candidate.id === request.params.id);

      if (schema === undefined) {
        throw new ScimError(404, `Schema '${request.params.id}' was not found.`);
      }

      return sendScim(reply, 200, schema);
    });

    scim.get("/Schemas/User", async (_request, reply) => sendScim(reply, 200, userSchema));
    scim.get("/Schemas/Group", async (_request, reply) => sendScim(reply, 200, groupSchema));
    registerUserRoutes(scim, database);
    registerGroupRoutes(scim, database);

    if (options.enableInspection === true) {
      registerInspectionRoute(scim, database);
    }

    done();
  });

  return app;
}
