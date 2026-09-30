import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { SCIM_ERROR_SCHEMA, SCIM_SERVICE_PROVIDER_CONFIG_SCHEMA } from "@scim-lifecycle-lab/scim-contract";

import { createScimApp } from "../src/app.js";
import { loadServiceConfig } from "../src/config.js";
import type { LifecycleSyncAdapter } from "../src/auth0-adapter.js";
import { migrateDatabase } from "../src/database/migrations.js";

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

describe("SCIM HTTPS deployment", () => {
  const bearerToken = "local-development-token";
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("allows loopback HTTP from %s", async (remoteAddress) => {
    app = createScimApp({ bearerToken });
    const response = await app.inject({
      method: "GET",
      url: "/Users",
      remoteAddress,
      headers: { authorization: `Bearer ${bearerToken}` }
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects public HTTP even with spoofed localhost and forwarded HTTPS headers", async () => {
    app = createScimApp({ bearerToken });
    const response = await app.inject({
      method: "GET",
      url: "/Users",
      remoteAddress: "203.0.113.1",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        host: "localhost",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-proto": "https"
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ status: "403" });
  });

  it("accepts HTTPS forwarded by an allowlisted proxy and emits HTTPS resource URLs", async () => {
    app = createScimApp({ bearerToken, enforceHttps: true, trustedProxies: ["10.0.0.10"] });
    const response = await app.inject({
      method: "POST",
      url: "/Users",
      remoteAddress: "10.0.0.10",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "content-type": "application/scim+json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "scim.example.test",
        "x-forwarded-for": "203.0.113.1"
      },
      payload: { userName: "proxied@example.test" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`https://scim.example.test/Users/${response.json().id}`);
    expect(response.json().meta.location).toBe(response.headers.location);
  });

  it("rejects HTTPS forwarding headers from an untrusted proxy", async () => {
    app = createScimApp({ bearerToken, enforceHttps: true, trustedProxies: ["10.0.0.10"] });
    const response = await app.inject({
      method: "GET",
      url: "/Users",
      remoteAddress: "10.0.0.11",
      headers: { authorization: `Bearer ${bearerToken}`, "x-forwarded-proto": "https" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("enforces HTTPS for non-loopback listeners and keeps proxy trust explicit", () => {
    expect(loadServiceConfig({ SCIM_BEARER_TOKEN: bearerToken })).toMatchObject({
      enforceHttps: false,
      trustedProxies: []
    });
    expect(loadServiceConfig({ SCIM_BEARER_TOKEN: bearerToken, SCIM_HOST: "0.0.0.0" })).toMatchObject({
      enforceHttps: true
    });
    expect(() => loadServiceConfig({
      SCIM_BEARER_TOKEN: bearerToken,
      SCIM_HOST: "0.0.0.0",
      SCIM_ENFORCE_HTTPS: "false"
    })).toThrow("cannot be disabled");
    expect(loadServiceConfig({
      SCIM_BEARER_TOKEN: bearerToken,
      SCIM_TRUST_PROXY: "127.0.0.1, ::1"
    }).trustedProxies).toEqual(["127.0.0.1", "::1"]);
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

  it("rejects duplicate Group names on create and replacement without losing membership", async () => {
    app = createScimApp({ bearerToken });
    const alice = await createUser("alice@example.test");
    const group = await createGroup([alice.id as string]);
    const duplicate = await app.inject({
      method: "POST", url: "/Groups", headers: authenticate(), payload: { displayName: "ENGINEERING" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ scimType: "uniqueness" });
    await app.inject({ method: "POST", url: "/Groups", headers: authenticate(), payload: { displayName: "Platform" } });
    const replacement = await app.inject({
      method: "PUT", url: `/Groups/${group.id}`, headers: authenticate(), payload: { displayName: "platform" }
    });
    expect(replacement.statusCode).toBe(409);
    const unchanged = await app.inject({
      method: "GET", url: `/Groups/${group.id}`, headers: { authorization: `Bearer ${bearerToken}` }
    });
    expect(unchanged.json()).toMatchObject({
      displayName: "Engineering", members: [{ value: alice.id }], meta: { version: 'W/"1"' }
    });
  });

  it("fully replaces and deletes a Group without deleting its users", async () => {
    app = createScimApp({ bearerToken });
    const alice = await createUser("alice@example.test");
    const bob = await createUser("bob@example.test");
    const group = await createGroup([alice.id as string]);
    const replacement = await app.inject({
      method: "PUT", url: `/Groups/${group.id}`, headers: authenticate(),
      payload: { ...group, displayName: "Platform", members: [{ value: bob.id }] }
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json()).toMatchObject({
      id: group.id, displayName: "Platform", members: [{ value: bob.id }], meta: { version: 'W/"2"' }
    });
    expect(replacement.json().members).toHaveLength(1);
    const cleared = await app.inject({
      method: "PUT", url: `/Groups/${group.id}`, headers: authenticate(), payload: { displayName: "Platform" }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().members).toEqual([]);
    const authorization = { authorization: `Bearer ${bearerToken}` };
    expect((await app.inject({ method: "DELETE", url: `/Groups/${group.id}`, headers: authorization })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/Groups/${group.id}`, headers: authorization })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/Groups", headers: authorization })).json()).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await app.inject({ method: "GET", url: "/Users", headers: authorization })).json().totalResults).toBe(2);
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

describe("SCIM protocol matrix", () => {
  const bearerToken = "local-development-token";
  const authorization = { authorization: `Bearer ${bearerToken}` };
  const headers = { ...authorization, "content-type": "application/scim+json" };
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(["Users", "Groups"])("rejects invalid pagination bounds for %s", async (resourceType) => {
    app = createScimApp({ bearerToken });
    for (const query of ["startIndex=0", "startIndex=1.5", "startIndex=nope", "count=-1", "count=101", "count=1.5", "count=nope"]) {
      const response = await app.inject({ method: "GET", url: `/${resourceType}?${query}`, headers: authorization });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ schemas: [SCIM_ERROR_SCHEMA], scimType: "invalidValue" });
    }
  });

  it.each(["Users", "Groups"])("paginates %s including count zero and an empty later page", async (resourceType) => {
    app = createScimApp({ bearerToken });
    const ids = [];
    for (const name of ["first@example.test", "second@example.test"]) {
      const created = await app.inject({
        method: "POST", url: `/${resourceType}`, headers,
        payload: resourceType === "Users" ? { userName: name } : { displayName: name }
      });
      expect(created.statusCode).toBe(201);
      ids.push(created.json().id as string);
    }
    const pages = [];
    for (const startIndex of [1, 2]) {
      const response = await app.inject({ method: "GET", url: `/${resourceType}?startIndex=${startIndex}&count=1`, headers: authorization });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ totalResults: 2, startIndex, itemsPerPage: 1 });
      pages.push(response.json().Resources[0].id as string);
    }
    expect(pages.sort()).toEqual(ids.sort());
    for (const query of ["count=0", "startIndex=3&count=1"]) {
      const response = await app.inject({ method: "GET", url: `/${resourceType}?${query}`, headers: authorization });
      expect(response.json()).toMatchObject({ totalResults: 2, itemsPerPage: 0, Resources: [] });
    }
  });

  it.each(["Users", "Groups"])("returns SCIM errors for unknown and malformed %s IDs", async (resourceType) => {
    app = createScimApp({ bearerToken });
    for (const id of ["bad-id", "00000000-0000-4000-8000-000000000099"]) {
      for (const method of ["GET", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({
          method, url: `/${resourceType}/${id}`,
          headers: method === "PUT" || method === "PATCH" ? headers : authorization,
          ...(method === "PUT"
            ? { payload: resourceType === "Users" ? { userName: "missing@example.test" } : { displayName: "Missing" } }
            : method === "PATCH" ? { payload: { Operations: [{ op: "replace", path: "displayName", value: "Missing" }] } } : {})
        });
        expect(response.statusCode).toBe(id === "bad-id" ? 400 : 404);
        expect(response.json().schemas).toEqual([SCIM_ERROR_SCHEMA]);
      }
    }
  });

  it("preserves ports in User and Group resource URLs", async () => {
    app = createScimApp({ bearerToken });
    const hostHeaders = { ...headers, host: "127.0.0.1:3000" };
    const user = await app.inject({ method: "POST", url: "/Users", headers: hostHeaders, payload: { userName: "port@example.test" } });
    expect(user.headers.location).toBe(`http://127.0.0.1:3000/Users/${user.json().id}`);
    expect(user.json().meta.location).toBe(user.headers.location);
    const group = await app.inject({
      method: "POST", url: "/Groups", headers: hostHeaders,
      payload: { displayName: "Ports", members: [{ value: user.json().id }] }
    });
    expect(group.headers.location).toBe(`http://127.0.0.1:3000/Groups/${group.json().id}`);
    expect(group.json().meta.location).toBe(group.headers.location);
    expect(group.json().members[0].$ref).toBe(user.headers.location);
  });

  it("rejects invalid tokens, content types, JSON, and unsupported Group filters", async () => {
    app = createScimApp({ bearerToken });
    const unauthenticated = await app.inject({ method: "GET", url: "/Users", headers: { authorization: "Bearer wrong-token" } });
    expect(unauthenticated.statusCode).toBe(401);
    const wrongContentType = await app.inject({
      method: "POST", url: "/Users", headers: { ...authorization, "content-type": "application/json" }, payload: { userName: "rejected@example.test" }
    });
    expect(wrongContentType.statusCode).toBe(415);
    const invalidJson = await app.inject({ method: "POST", url: "/Users", headers, payload: "{" });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json().scimType).toBe("invalidSyntax");
    const unsupportedFilter = await app.inject({ method: "GET", url: "/Groups?filter=members%20pr", headers: authorization });
    expect(unsupportedFilter.statusCode).toBe(400);
    expect(unsupportedFilter.json().scimType).toBe("invalidFilter");
  });

  it("keeps inspection disabled by default and bearer-protected when enabled", async () => {
    app = createScimApp({ bearerToken });
    expect((await app.inject({ method: "GET", url: "/_dev/inspection", headers: authorization })).statusCode).toBe(404);
    await app.close();
    app = createScimApp({ bearerToken, enableInspection: true });
    expect((await app.inject({ method: "GET", url: "/_dev/inspection" })).statusCode).toBe(401);
  });

  it("upgrades existing audit data and reapplies migrations idempotently", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database);
      database.exec("ALTER TABLE audit_events DROP COLUMN adapter_outcome; DELETE FROM schema_migrations WHERE id = '003_audit_adapter_outcome';");
      database.prepare("INSERT INTO audit_events (id, correlation_id, request_method, request_path, http_status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("legacy-event", "legacy-correlation", "GET", "/Users", 200, new Date().toISOString());
      app = createScimApp({ bearerToken, database, enableInspection: true });
      const inspection = await app.inject({ method: "GET", url: "/_dev/inspection", headers: authorization });
      expect(inspection.json().auditEvents).toEqual([expect.objectContaining({ id: "legacy-event", adapterOutcome: null })]);
      expect(migrateDatabase(database)).toEqual([]);
      await app.close();
      app = undefined;
    } finally {
      database.close();
    }
  });
});

describe("SCIM lifecycle adapter integration", () => {
  const bearerToken = "local-development-token";
  const headers = { authorization: `Bearer ${bearerToken}`, "content-type": "application/scim+json" };
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("audits the disabled adapter without affecting provisioning", async () => {
    app = createScimApp({ bearerToken, enableInspection: true });
    const created = await app.inject({ method: "POST", url: "/Users", headers, payload: { userName: "disabled-sync@example.test" } });
    expect(created.statusCode).toBe(201);
    const inspection = await app.inject({ method: "GET", url: "/_dev/inspection", headers });
    expect(inspection.json().auditEvents[0].adapterOutcome).toEqual({ adapter: "auth0", status: "disabled" });
  });

  it("syncs only committed User mutations and blocks on deletion", async () => {
    const syncUser = vi.fn<LifecycleSyncAdapter["syncUser"]>().mockResolvedValue({ adapter: "auth0", status: "synced" });
    app = createScimApp({ bearerToken, enableInspection: true, lifecycleAdapter: { syncUser } });
    const created = await app.inject({
      method: "POST", url: "/Users", headers,
      payload: { userName: "synced@example.test", externalId: "auth0|synced-001" }
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().id as string;
    const disabled = await app.inject({
      method: "PATCH", url: `/Users/${userId}`, headers,
      payload: { Operations: [{ op: "replace", path: "active", value: false }] }
    });
    expect(disabled.statusCode).toBe(200);
    const enabled = await app.inject({
      method: "PUT", url: `/Users/${userId}`, headers,
      payload: { userName: "synced@example.test", externalId: "auth0|synced-001", active: true }
    });
    expect(enabled.statusCode).toBe(200);
    const deleted = await app.inject({
      method: "DELETE", url: `/Users/${userId}`, headers: { authorization: `Bearer ${bearerToken}` }
    });
    expect(deleted.statusCode).toBe(204);
    expect(syncUser.mock.calls.map(([user]) => user.active)).toEqual([true, false, true, false]);
    expect(syncUser.mock.calls[1]?.[1]).toBe(disabled.headers["x-correlation-id"]);
    const inspection = await app.inject({ method: "GET", url: "/_dev/inspection", headers });
    expect(inspection.json().auditEvents).toHaveLength(4);
    expect(inspection.json().auditEvents.every((event: { adapterOutcome: { status: string } }) => event.adapterOutcome.status === "synced")).toBe(true);
  });

  it("keeps SCIM authoritative and sanitizes unexpected adapter failures", async () => {
    const syncUser = vi.fn<LifecycleSyncAdapter["syncUser"]>().mockRejectedValue(new Error("private-error-sentinel"));
    app = createScimApp({ bearerToken, enableInspection: true, lifecycleAdapter: { syncUser } });
    const created = await app.inject({ method: "POST", url: "/Users", headers, payload: { userName: "failed-sync@example.test" } });
    expect(created.statusCode).toBe(201);
    const disabled = await app.inject({
      method: "PATCH", url: `/Users/${created.json().id}`, headers,
      payload: { Operations: [{ op: "replace", path: "active", value: false }] }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().active).toBe(false);
    const inspection = await app.inject({ method: "GET", url: "/_dev/inspection", headers });
    expect(inspection.body).not.toContain("private-error-sentinel");
    expect(inspection.json().auditEvents.every((event: { adapterOutcome: { status: string } }) => event.adapterOutcome.status === "failed")).toBe(true);
  });

  it("does not sync an invalid atomic PATCH", async () => {
    const syncUser = vi.fn<LifecycleSyncAdapter["syncUser"]>().mockResolvedValue({ adapter: "auth0", status: "synced" });
    app = createScimApp({ bearerToken, lifecycleAdapter: { syncUser } });
    const created = await app.inject({ method: "POST", url: "/Users", headers, payload: { userName: "atomic-sync@example.test" } });
    syncUser.mockClear();
    const response = await app.inject({
      method: "PATCH", url: `/Users/${created.json().id}`, headers,
      payload: { Operations: [{ op: "replace", path: "active", value: false }, { op: "replace", path: "password", value: "rejected" }] }
    });
    expect(response.statusCode).toBe(400);
    expect(syncUser).not.toHaveBeenCalled();
    const unchanged = await app.inject({ method: "GET", url: `/Users/${created.json().id}`, headers });
    expect(unchanged.json().active).toBe(true);
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

    const userId = createdResponse.json().id as string;
    const populatedGroupResponse = await app.inject({
      method: "POST",
      url: "/Groups",
      headers,
      payload: { displayName: "Engineering", members: [{ value: userId }] }
    });
    expect(populatedGroupResponse.statusCode).toBe(201);

    const emptyGroupResponse = await app.inject({
      method: "POST",
      url: "/Groups",
      headers,
      payload: { displayName: "Empty" }
    });
    expect(emptyGroupResponse.statusCode).toBe(201);

    const inspectionResponse = await app.inject({
      method: "GET",
      url: "/_dev/inspection",
      headers: { authorization: `Bearer ${bearerToken}` }
    });

    expect(inspectionResponse.statusCode).toBe(200);
    const inspection = inspectionResponse.json() as {
      users: Array<{ userName: string }>;
      groups: Array<{ displayName: string; members: Array<{ id: string; userName: string }> }>;
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
    expect(inspection.groups).toHaveLength(2);
    expect(inspection.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "Engineering",
          members: [{ id: userId, userName: "audited@example.test" }]
        }),
        expect.objectContaining({ displayName: "Empty", members: [] })
      ])
    );

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

  it("redacts sensitive PATCH values and mutation snapshots", async () => {
    app = createScimApp({
      bearerToken,
      enableInspection: true,
      auditRedactAttributes: ["displayName", "department", "givenName", "emails"]
    });
    const headers = {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/scim+json"
    };
    const createdResponse = await app.inject({
      method: "POST",
      url: "/Users",
      headers,
      payload: { userName: "patch-audit@example.test" }
    });
    const userId = createdResponse.json().id as string;
    const operations = [
      { path: "Password", value: "password-redaction-sentinel", expectedStatus: 400 },
      { path: "displayName", value: "profile-redaction-sentinel", expectedStatus: 200 },
      {
        path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
        value: "department-redaction-sentinel",
        expectedStatus: 200
      },
      { path: "name.givenName", value: "name-redaction-sentinel", expectedStatus: 200 },
      { path: 'emails[type eq "work"].value', value: "email-redaction-sentinel", expectedStatus: 400 }
    ];

    for (const operation of operations) {
      const response = await app.inject({
        method: "PATCH",
        url: `/Users/${userId}`,
        headers,
        payload: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: operation.path, value: operation.value }]
        }
      });
      expect(response.statusCode).toBe(operation.expectedStatus);
    }

    const inspectionResponse = await app.inject({
      method: "GET",
      url: "/_dev/inspection",
      headers
    });
    const inspection = inspectionResponse.json() as {
      auditEvents: Array<{ method: string; requestPayload: unknown; beforeState: unknown; afterState: unknown }>;
    };
    const patchEvents = inspection.auditEvents.filter((event) => event.method === "PATCH");

    expect(patchEvents).toHaveLength(operations.length);
    for (const event of patchEvents) {
      expect(event.requestPayload).toMatchObject({ Operations: [{ value: "[REDACTED]" }] });
      for (const operation of operations) {
        expect(JSON.stringify(event)).not.toContain(operation.value);
      }
    }
  });
});