import { describe, expect, it } from "vitest";

import {
  SCIM_ENTERPRISE_USER_SCHEMA,
  SCIM_ERROR_SCHEMA,
  ScimError,
  createScimErrorPayload,
  createScimListResponse,
  scimGroupInputSchema,
  scimUserInputSchema,
  scimErrorPayloadSchema,
  serviceProviderConfig
} from "../src/index.js";

describe("SCIM contract", () => {
  it("serializes a SCIM uniqueness error", () => {
    const payload = createScimErrorPayload(409, "userName already exists", "uniqueness");

    expect(payload).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      detail: "userName already exists",
      status: "409",
      scimType: "uniqueness"
    });
    expect(scimErrorPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("preserves error metadata when converted to a payload", () => {
    const error = new ScimError(404, "User was not found");

    expect(error.toPayload()).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      detail: "User was not found",
      status: "404"
    });
  });

  it("creates a valid list response from the requested page", () => {
    expect(createScimListResponse([{ id: "user-1" }], 3, 2)).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 3,
      startIndex: 2,
      itemsPerPage: 1,
      Resources: [{ id: "user-1" }]
    });
  });

  it("advertises only the currently implemented lifecycle features", () => {
    expect(serviceProviderConfig.patch.supported).toBe(true);
    expect(serviceProviderConfig.filter).toEqual({ supported: true, maxResults: 100 });
    expect(serviceProviderConfig.etag.supported).toBe(false);
  });

  it("accepts enterprise profile attributes but rejects credentials", () => {
    const validUser = scimUserInputSchema.parse({
      userName: "alice@example.test",
      [SCIM_ENTERPRISE_USER_SCHEMA]: { department: "Engineering", employeeNumber: "E-001" }
    });

    expect(validUser.active).toBe(true);
    expect(validUser[SCIM_ENTERPRISE_USER_SCHEMA]).toEqual({
      department: "Engineering",
      employeeNumber: "E-001"
    });
    expect(scimUserInputSchema.safeParse({ userName: "alice@example.test", password: "secret" }).success).toBe(
      false
    );
  });

  it("requires UUID values for Group member references", () => {
    expect(
      scimGroupInputSchema.safeParse({
        displayName: "Engineering",
        members: [{ value: "not-a-local-user-id" }]
      }).success
    ).toBe(false);
  });
});