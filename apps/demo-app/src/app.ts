import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";

import type { DemoAuthentication, AuthenticatedIdentity } from "./authentication.js";
import { resolveLifecycleAccess } from "./lifecycle-gate.js";
import type { ScimDirectoryClient, ScimDirectoryUser } from "./scim-client.js";
import { renderAccessDenied, renderDashboard, renderDirectoryUnavailable, renderSignedOut } from "./views.js";

export interface DemoAppOptions {
  authentication: DemoAuthentication;
  directoryClient: ScimDirectoryClient;
}

interface DemoLocals {
  identity?: AuthenticatedIdentity;
  user?: ScimDirectoryUser;
}

function wantsJson(request: Request): boolean {
  return request.path.startsWith("/api/");
}

function denyLifecycleAccess(
  request: Request,
  response: Response,
  reason: "missing" | "ambiguous" | "inactive"
): void {
  if (wantsJson(request)) {
    response.status(403).json({ error: "lifecycle_access_denied", reason });
    return;
  }

  response.status(403).type("html").send(renderAccessDenied(reason));
}

function denyDirectoryUnavailable(request: Request, response: Response): void {
  if (wantsJson(request)) {
    response.status(503).json({ error: "lifecycle_directory_unavailable" });
    return;
  }

  response.status(503).type("html").send(renderDirectoryUnavailable());
}

function createLifecycleGate(options: DemoAppOptions): RequestHandler {
  return async (request, response, next) => {
    const identity = options.authentication.getIdentity(request);

    if (identity === undefined) {
      response.status(401).json({ error: "authenticated_subject_missing" });
      return;
    }

    try {
      const decision = await resolveLifecycleAccess(options.directoryClient, identity.subject);

      if (decision.status !== "allowed") {
        denyLifecycleAccess(request, response, decision.status);
        return;
      }

      const locals = response.locals as DemoLocals;
      locals.identity = identity;
      locals.user = decision.user;
      next();
    } catch {
      denyDirectoryUnavailable(request, response);
    }
  };
}

function setSecurityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  next();
}

export function createDemoApp(options: DemoAppOptions): express.Express {
  const app = express();
  const lifecycleGate = createLifecycleGate(options);

  app.disable("x-powered-by");
  app.use(setSecurityHeaders);
  app.use(options.authentication.middleware);

  app.get("/health", (_request, response) => response.json({ status: "ok" }));

  app.get("/", (request, response) => {
    if (options.authentication.isAuthenticated(request)) {
      response.redirect("/app");
      return;
    }

    response.type("html").send(renderSignedOut());
  });

  app.get("/app", options.authentication.requireAuthentication, lifecycleGate, (_request, response) => {
    const locals = response.locals as DemoLocals;

    if (locals.identity === undefined || locals.user === undefined) {
      response.status(500).type("html").send(renderDirectoryUnavailable());
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.type("html").send(renderDashboard(locals.identity, locals.user));
  });

  app.get("/api/session", options.authentication.requireAuthentication, lifecycleGate, (_request, response) => {
    const locals = response.locals as DemoLocals;

    if (locals.identity === undefined || locals.user === undefined) {
      response.status(500).json({ error: "lifecycle_directory_unavailable" });
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.json({
      auth0: { sub: locals.identity.subject },
      scim: {
        id: locals.user.id,
        userName: locals.user.userName,
        displayName: locals.user.displayName,
        active: locals.user.active
      }
    });
  });

  app.use((_error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      return;
    }

    if (wantsJson(request)) {
      response.status(500).json({ error: "application_error" });
      return;
    }

    response.status(500).type("html").send(renderDirectoryUnavailable());
  });

  return app;
}
