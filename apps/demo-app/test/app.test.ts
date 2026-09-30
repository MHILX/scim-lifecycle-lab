import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createDemoApp } from "../src/app.js";
import type { AuthenticatedIdentity, DemoAuthentication } from "../src/authentication.js";
import type { ScimDirectoryClient, ScimDirectoryUser } from "../src/scim-client.js";

const identity: AuthenticatedIdentity = {
  subject: "auth0|alice-001",
  displayName: "Alice Example",
  email: "alice@example.test"
};

function fakeAuthentication(currentIdentity: AuthenticatedIdentity | undefined): DemoAuthentication {
  const requireAuthentication: RequestHandler = (_request, response, next) => {
    if (currentIdentity === undefined) {
      response.status(401).send("Authentication required.");
      return;
    }

    next();
  };

  return {
    middleware: (_request, _response, next) => next(),
    requireAuthentication,
    isAuthenticated: () => currentIdentity !== undefined,
    getIdentity: () => currentIdentity
  };
}

function scimUser(overrides: Partial<ScimDirectoryUser> = {}): ScimDirectoryUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    externalId: identity.subject,
    userName: "alice@example.test",
    displayName: "Alice Example",
    active: true,
    ...overrides
  };
}

function fakeDirectory(users: ScimDirectoryUser[]): ScimDirectoryClient {
  return { findUsersByExternalId: vi.fn(async () => users) };
}

describe("demo application lifecycle gate", () => {
  it("offers an Auth0 sign-in route to unauthenticated visitors", async () => {
    const app = createDemoApp({
      authentication: fakeAuthentication(undefined),
      directoryClient: fakeDirectory([])
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain('href="/login"');
  });

  it("checks an active SCIM record on every protected request", async () => {
    const directory = fakeDirectory([scimUser()]);
    const app = createDemoApp({ authentication: fakeAuthentication(identity), directoryClient: directory });

    const pageResponse = await request(app).get("/app");
    const apiResponse = await request(app).get("/api/session");

    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers["cache-control"]).toBe("no-store");
    expect(pageResponse.text).toContain("Active SCIM access");
    expect(apiResponse.status).toBe(200);
    expect(apiResponse.body).toMatchObject({
      auth0: { sub: identity.subject },
      scim: { userName: "alice@example.test", active: true }
    });
    expect(directory.findUsersByExternalId).toHaveBeenCalledTimes(2);
  });

  it("denies an authenticated inactive SCIM user", async () => {
    const app = createDemoApp({
      authentication: fakeAuthentication(identity),
      directoryClient: fakeDirectory([scimUser({ active: false })])
    });

    const pageResponse = await request(app).get("/app");
    const apiResponse = await request(app).get("/api/session");

    expect(pageResponse.status).toBe(403);
    expect(pageResponse.text).toContain("Access denied");
    expect(apiResponse.status).toBe(403);
    expect(apiResponse.body).toEqual({ error: "lifecycle_access_denied", reason: "inactive" });
  });

  it("fails closed when the SCIM directory cannot be reached", async () => {
    const directory: ScimDirectoryClient = {
      findUsersByExternalId: vi.fn(async () => {
        throw new Error("connection refused");
      })
    };
    const app = createDemoApp({ authentication: fakeAuthentication(identity), directoryClient: directory });

    const response = await request(app).get("/api/session");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "lifecycle_directory_unavailable" });
  });
});