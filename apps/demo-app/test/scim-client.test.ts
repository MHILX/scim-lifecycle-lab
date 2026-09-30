import { describe, expect, it, vi } from "vitest";

import { HttpScimDirectoryClient, ScimDirectoryUnavailableError } from "../src/scim-client.js";

describe("HTTP SCIM directory client", () => {
  it("performs an exact externalId lookup with the bearer token on the server request", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(
        JSON.stringify({
          totalResults: 1,
          Resources: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              externalId: 'auth0|alice"quoted',
              userName: "alice@example.test",
              active: true
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/scim+json" } }
      )
    );
    const client = new HttpScimDirectoryClient(
      "http://127.0.0.1:3000",
      "local-development-token",
      fetchImplementation
    );

    const users = await client.findUsersByExternalId('auth0|alice"quoted');

    expect(users).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        externalId: 'auth0|alice"quoted',
        userName: "alice@example.test",
        active: true
      }
    ]);
    expect(fetchImplementation).toHaveBeenCalledOnce();

    const [url, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).pathname).toBe("/Users");
    expect((url as URL).searchParams.get("filter")).toBe('externalId eq "auth0|alice\\"quoted"');
    expect((request as RequestInit).headers).toEqual({ authorization: "Bearer local-development-token" });
  });

  it("fails closed for unreachable, rejected, and malformed directory responses", async () => {
    const unreachableClient = new HttpScimDirectoryClient(
      "http://127.0.0.1:3000",
      "local-development-token",
      async () => {
        throw new Error("connection refused");
      }
    );
    const rejectedClient = new HttpScimDirectoryClient(
      "http://127.0.0.1:3000",
      "local-development-token",
      async () => new Response("forbidden", { status: 403 })
    );
    const malformedClient = new HttpScimDirectoryClient(
      "http://127.0.0.1:3000",
      "local-development-token",
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );

    await expect(unreachableClient.findUsersByExternalId("auth0|alice")).rejects.toBeInstanceOf(
      ScimDirectoryUnavailableError
    );
    await expect(rejectedClient.findUsersByExternalId("auth0|alice")).rejects.toMatchObject({ statusCode: 403 });
    await expect(malformedClient.findUsersByExternalId("auth0|alice")).rejects.toBeInstanceOf(
      ScimDirectoryUnavailableError
    );
  });
});