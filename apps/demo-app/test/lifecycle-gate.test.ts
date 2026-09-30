import { describe, expect, it, vi } from "vitest";

import { resolveLifecycleAccess } from "../src/lifecycle-gate.js";
import type { ScimDirectoryClient, ScimDirectoryUser } from "../src/scim-client.js";

function user(overrides: Partial<ScimDirectoryUser> = {}): ScimDirectoryUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    externalId: "auth0|alice-001",
    userName: "alice@example.test",
    active: true,
    ...overrides
  };
}

function directoryClient(users: ScimDirectoryUser[]): ScimDirectoryClient {
  return { findUsersByExternalId: vi.fn(async () => users) };
}

describe("SCIM lifecycle gate", () => {
  it("allows exactly one active SCIM user mapped to the Auth0 subject", async () => {
    const directory = directoryClient([user()]);

    await expect(resolveLifecycleAccess(directory, "auth0|alice-001")).resolves.toEqual({
      status: "allowed",
      user: user()
    });
    expect(directory.findUsersByExternalId).toHaveBeenCalledWith("auth0|alice-001");
  });

  it("denies a missing, inactive, or ambiguous local mapping", async () => {
    await expect(resolveLifecycleAccess(directoryClient([]), "auth0|alice-001")).resolves.toEqual({ status: "missing" });
    await expect(
      resolveLifecycleAccess(directoryClient([user({ active: false })]), "auth0|alice-001")
    ).resolves.toEqual({ status: "inactive" });
    await expect(
      resolveLifecycleAccess(
        directoryClient([user(), user({ id: "00000000-0000-4000-8000-000000000002" })]),
        "auth0|alice-001"
      )
    ).resolves.toEqual({ status: "ambiguous" });
  });
});
