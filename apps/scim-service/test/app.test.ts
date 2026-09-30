import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { SCIM_ERROR_SCHEMA, SCIM_SERVICE_PROVIDER_CONFIG_SCHEMA } from "@scim-lifecycle-lab/scim-contract";

import { createScimApp } from "../src/app.js";

describe("SCIM service discovery", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("exposes an unauthenticated health check", async () => {
    app = createScimApp({ bearerToken: "local-development-token" });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns a SCIM error when a discovery request has no bearer token", async () => {
    app = createScimApp({ bearerToken: "local-development-token" });

    const response = await app.inject({ method: "GET", url: "/Schemas" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/scim+json");
    expect(response.json()).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      detail: "A valid bearer token is required.",
      status: "401"
    });
  });

  it("authenticates a mutation before considering an unsupported content type", async () => {
    app = createScimApp({ bearerToken: "local-development-token" });

    const response = await app.inject({
      method: "POST",
      url: "/Users",
      headers: { "content-type": "application/json" },
      payload: { userName: "alice@example.test" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: "401" });
  });

  it("returns a SCIM 413 error when a request body exceeds the configured limit", async () => {
    app = createScimApp({ bearerToken: "local-development-token", bodyLimit: 64 });

    const response = await app.inject({
      method: "POST",
      url: "/Users",
      headers: {
        authorization: "Bearer local-development-token",
        "content-type": "application/scim+json"
      },
      payload: { userName: "alice@example.test", displayName: "A name longer than the test body limit" }
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ status: "413" });
  });

  it("serves discovery documents to an authenticated request", async () => {
    app = createScimApp({ bearerToken: "local-development-token" });

    const response = await app.inject({
      method: "GET",
      url: "/ServiceProviderConfig",
      headers: {
        authorization: "Bearer local-development-token",
        "x-correlation-id": "discovery-test-001"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("discovery-test-001");
    expect(response.json()).toMatchObject({
      schemas: [SCIM_SERVICE_PROVIDER_CONFIG_SCHEMA],
      patch: { supported: true },
      filter: { supported: true, maxResults: 100 }
    });
  });

  it("returns SCIM list responses for resource types", async () => {
    app = createScimApp({ bearerToken: "local-development-token" });

    const response = await app.inject({
      method: "GET",
      url: "/ResourceTypes",
      headers: { authorization: "Bearer local-development-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2
    });
  });
});

describe("SCIM User lifecycle", () => {
  const bearerToken = "local-development-token";
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function authenticate(): { authorization: string; "content-type": string } {
    return {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/scim+json"
    };
  }

  async function createAlice(): Promise<Record<string, unknown>> {
    if (app === undefined) {
      throw new Error("SCIM app was not initialized.");
    }

    const response = await app.inject({
      method: "POST",
      url: "/Users",
      headers: authenticate(),
      payload: {
        schemas: [
          "urn:ietf:params:scim:schemas:core:2.0:User",
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
        ],
        externalId: "employee-001",
        userName: "alice@example.test",
        name: { givenName: "Alice", familyName: "Example" },
        displayName: "Alice Example",
        active: true,
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
          department: "Engineering",
          employeeNumber: "E-001"
        }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toContain("/Users/");
    return response.json() as Record<string, unknown>;
  }

  it("creates a user and returns a paginated userName filter result", async () => {
    app = createScimApp({ bearerToken });
    const createdUser = await createAlice();

    const response = await app.inject({
      method: "GET",
      url: "/Users?filter=userName%20eq%20%22alice%40example.test%22&startIndex=1&count=1",
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [
        {
          id: createdUser.id,
          userName: "alice@example.test",
          active: true,
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
            department: "Engineering",
            employeeNumber: "E-001"
          }
        }
      ]
    });
  });

  it("resolves a User by an exact externalId mapping", async () => {
    app = createScimApp({ bearerToken });
    const createdUser = await createAlice();

    const response = await app.inject({
      method: "GET",
      url: "/Users?filter=externalId%20eq%20%22employee-001%22",
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: createdUser.id, externalId: "employee-001" }]
    });
  });

  it("rejects a duplicate externalId mapping", async () => {
    app = createScimApp({ bearerToken });
    await createAlice();

    const response = await app.inject({
      method: "POST",
      url: "/Users",
      headers: authenticate(),
      payload: {
        externalId: "employee-001",
        userName: "another-alice@example.test",
        active: true
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
  });

  it("returns a uniqueness error for a duplicate userName", async () => {
    app = createScimApp({ bearerToken });
    await createAlice();

    const response = await app.inject({
      method: "POST",
      url: "/Users",
      headers: authenticate(),
      payload: { userName: "ALICE@example.test" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
  });

  it("does not persist any PATCH operation when a later operation is invalid", async () => {
    app = createScimApp({ bearerToken });
    const createdUser = await createAlice();
    const userId = createdUser.id as string;

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/Users/${userId}`,
      headers: authenticate(),
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          {
            op: "replace",
            path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
            value: "Product"
          },
          { op: "replace", path: "active", value: "not-a-boolean" }
        ]
      }
    });

    expect(patchResponse.statusCode).toBe(400);
    expect(patchResponse.json()).toMatchObject({ status: "400", scimType: "invalidValue" });

    const getResponse = await app.inject({
      method: "GET",
      url: `/Users/${userId}`,
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      active: true,
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Engineering" }
    });
  });

  it("accepts a full replacement with read-only fields and permanently deletes the user", async () => {
    app = createScimApp({ bearerToken });
    const createdUser = await createAlice();
    const userId = createdUser.id as string;

    const replacement = {
      ...createdUser,
      displayName: "Alice Updated",
      active: false
    };
    const replacementResponse = await app.inject({
      method: "PUT",
      url: `/Users/${userId}`,
      headers: authenticate(),
      payload: replacement
    });

    expect(replacementResponse.statusCode).toBe(200);
    expect(replacementResponse.json()).toMatchObject({ displayName: "Alice Updated", active: false });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/Users/${userId}`,
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(deleteResponse.statusCode).toBe(204);

    const getResponse = await app.inject({
      method: "GET",
      url: `/Users/${userId}`,
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(getResponse.statusCode).toBe(404);
    expect(getResponse.json()).toMatchObject({ status: "404" });
  });

  it("rejects an unsupported filter instead of silently mis-filtering", async () => {
    app = createScimApp({ bearerToken });

    const response = await app.inject({
      method: "GET",
      url: "/Users?filter=active%20eq%20true",
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: "400", scimType: "invalidFilter" });
  });
});

describe("SCIM Group lifecycle", () => {
  const bearerToken = "local-development-token";
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function authenticate(): { authorization: string; "content-type": string } {
    return {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/scim+json"
    };
  }

  async function createUser(userName: string): Promise<Record<string, unknown>> {
    if (app === undefined) {
      throw new Error("SCIM app was not initialized.");
    }

    const response = await app.inject({
      method: "POST",
      url: "/Users",
      headers: authenticate(),
      payload: { userName }
    });

    expect(response.statusCode).toBe(201);
    return response.json() as Record<string, unknown>;
  }

  async function createGroup(memberIds: string[]): Promise<Record<string, unknown>> {
    if (app === undefined) {
      throw new Error("SCIM app was not initialized.");
    }

    const response = await app.inject({
      method: "POST",
      url: "/Groups",
      headers: authenticate(),
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Engineering",
        members: memberIds.map((value) => ({ value }))
      }
    });

    expect(response.statusCode).toBe(201);
    return response.json() as Record<string, unknown>;
  }

  it("manages membership idempotently and filters groups by displayName", async () => {
    app = createScimApp({ bearerToken });
    const alice = await createUser("alice@example.test");
    const bob = await createUser("bob@example.test");
    const group = await createGroup([alice.id as string]);
    const groupId = group.id as string;

    const addAliceAgain = await app.inject({
      method: "PATCH",
      url: `/Groups/${groupId}`,
      headers: authenticate(),
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "add", path: "members", value: [{ value: alice.id }] }]
      }
    });

    expect(addAliceAgain.statusCode).toBe(200);
    expect((addAliceAgain.json().members as unknown[]).length).toBe(1);

    const updateMembers = await app.inject({
      method: "PATCH",
      url: `/Groups/${groupId}`,
      headers: authenticate(),
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "add", path: "members", value: [{ value: bob.id }] },
          { op: "remove", path: "members", value: [{ value: alice.id }] }
        ]
      }
    });

    expect(updateMembers.statusCode).toBe(200);
    expect(updateMembers.json()).toMatchObject({ members: [{ value: bob.id, display: "bob@example.test" }] });

    const listResponse = await app.inject({
      method: "GET",
      url: "/Groups?filter=displayName%20eq%20%22Engineering%22",
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({ totalResults: 1, itemsPerPage: 1 });
  });

  it("does not persist a group PATCH when one member reference is unknown", async () => {
    app = createScimApp({ bearerToken });
    const alice = await createUser("alice@example.test");
    const bob = await createUser("bob@example.test");
    const group = await createGroup([alice.id as string]);
    const groupId = group.id as string;

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/Groups/${groupId}`,
      headers: authenticate(),
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "add", path: "members", value: [{ value: bob.id }] },
          {
            op: "add",
            path: "members",
            value: [{ value: "00000000-0000-4000-8000-000000000099" }]
          }
        ]
      }
    });

    expect(patchResponse.statusCode).toBe(400);
    expect(patchResponse.json()).toMatchObject({ status: "400", scimType: "invalidValue" });

    const getResponse = await app.inject({
      method: "GET",
      url: `/Groups/${groupId}`,
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({ members: [{ value: alice.id }] });
    expect((getResponse.json().members as unknown[]).length).toBe(1);
  });

  it("removes group membership when a member User is deleted", async () => {
    app = createScimApp({ bearerToken });
    const alice = await createUser("alice@example.test");
    const group = await createGroup([alice.id as string]);
    const groupId = group.id as string;

    const deleteUserResponse = await app.inject({
      method: "DELETE",
      url: `/Users/${alice.id as string}`,
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(deleteUserResponse.statusCode).toBe(204);

    const groupResponse = await app.inject({
      method: "GET",
      url: `/Groups/${groupId}`,
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(groupResponse.statusCode).toBe(200);
    expect(groupResponse.json()).toMatchObject({
      members: [],
      meta: { version: "W/\"2\"" }
    });
  });
});

describe("SCIM audit inspection", () => {
  const bearerToken = "local-development-token";
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("records redacted outcomes and exposes them through the protected inspection API", async () => {
    app = createScimApp({ bearerToken, enableInspection: true });
    const headers = {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/scim+json"
    };

    const rejectedResponse = await app.inject({
      method: "POST",
      url: "/Users",
      headers,
      payload: { userName: "rejected@example.test", password: "never-store-this" }
    });
    expect(rejectedResponse.statusCode).toBe(400);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/Users",
      headers,
      payload: { userName: "audited@example.test" }
    });
    expect(createdResponse.statusCode).toBe(201);

    const inspectionResponse = await app.inject({
      method: "GET",
      url: "/_dev/inspection",
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(inspectionResponse.statusCode).toBe(200);
    const inspection = inspectionResponse.json() as {
      users: Array<{ userName: string }>;
      auditEvents: Array<{
        actor: string;
        path: string;
        status: number;
        requestMetadata: Record<string, unknown>;
        requestPayload: Record<string, unknown> | null;
        beforeState: unknown;
        afterState: Record<string, unknown> | null;
      }>;
    };

    expect(inspection.users).toEqual([expect.objectContaining({ userName: "audited@example.test" })]);

    const rejectedEvent = inspection.auditEvents.find(
      (event) => event.path === "/Users" && event.status === 400
    );
    expect(rejectedEvent).toMatchObject({
      actor: "scim-client",
      requestPayload: { userName: "rejected@example.test", password: "[REDACTED]" }
    });
    expect(rejectedEvent?.requestMetadata).not.toHaveProperty("authorization");

    const createdEvent = inspection.auditEvents.find(
      (event) => event.path === "/Users" && event.status === 201
    );
    expect(createdEvent).toMatchObject({
      beforeState: null,
      afterState: { userName: "audited@example.test", active: true }
    });
  });
});