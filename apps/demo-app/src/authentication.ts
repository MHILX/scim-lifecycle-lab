import type { Request, RequestHandler } from "express";
import { auth, requiresAuth } from "express-openid-connect";

import type { DemoAppConfig } from "./config.js";

export interface AuthenticatedIdentity {
  subject: string;
  displayName?: string;
  email?: string;
}

export interface DemoAuthentication {
  middleware: RequestHandler;
  requireAuthentication: RequestHandler;
  isAuthenticated(request: Request): boolean;
  getIdentity(request: Request): AuthenticatedIdentity | undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function createAuth0Authentication(config: DemoAppConfig): DemoAuthentication {
  return {
    middleware: auth({
      authRequired: false,
      auth0Logout: true,
      secret: config.auth0SessionSecret,
      baseURL: config.baseUrl,
      clientID: config.auth0ClientId,
      clientSecret: config.auth0ClientSecret,
      issuerBaseURL: config.auth0IssuerBaseUrl,
      authorizationParams: {
        response_type: "code",
        scope: "openid profile email"
      }
    }),
    requireAuthentication: requiresAuth(),
    isAuthenticated: (request) => request.oidc.isAuthenticated(),
    getIdentity: (request) => {
      const user = request.oidc.user;
      const subject = asNonEmptyString(user?.sub);

      if (user === undefined || subject === undefined) {
        return undefined;
      }

      const displayName = asNonEmptyString(user.name);
      const email = asNonEmptyString(user.email);

      return {
        subject,
        ...(displayName === undefined ? {} : { displayName }),
        ...(email === undefined ? {} : { email })
      };
    }
  };
}
