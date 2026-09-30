import { z } from "zod";

export const SCIM_CONTENT_TYPE = "application/scim+json";

export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_SERVICE_PROVIDER_CONFIG_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCIM_RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCIM_SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";
export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_ENTERPRISE_USER_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

export const scimTypeSchema = z.enum([
  "invalidFilter",
  "invalidPath",
  "invalidSyntax",
  "invalidValue",
  "mutability",
  "noTarget",
  "sensitivity",
  "uniqueness"
]);

export type ScimType = z.infer<typeof scimTypeSchema>;
export type ScimErrorStatus = 400 | 401 | 403 | 404 | 409 | 412 | 413 | 415 | 500;

export interface ScimErrorPayload {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  detail: string;
  status: string;
  scimType?: ScimType;
}

export const scimErrorPayloadSchema = z.object({
  schemas: z.tuple([z.literal(SCIM_ERROR_SCHEMA)]),
  detail: z.string().min(1),
  status: z.string().regex(/^[1-5][0-9]{2}$/),
  scimType: scimTypeSchema.optional()
});

export class ScimError extends Error {
  public readonly statusCode: ScimErrorStatus;
  public readonly scimType: ScimType | undefined;

  public constructor(statusCode: ScimErrorStatus, detail: string, scimType?: ScimType) {
    super(detail);
    this.name = "ScimError";
    this.statusCode = statusCode;
    this.scimType = scimType;
  }

  public toPayload(): ScimErrorPayload {
    return createScimErrorPayload(this.statusCode, this.message, this.scimType);
  }
}

export function createScimErrorPayload(
  statusCode: ScimErrorStatus,
  detail: string,
  scimType?: ScimType
): ScimErrorPayload {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    detail,
    status: String(statusCode),
    ...(scimType === undefined ? {} : { scimType })
  };
}

export const paginationQuerySchema = z
  .object({
    startIndex: z.coerce.number().int().min(1).default(1),
    count: z.coerce.number().int().min(0).max(100).default(100),
    filter: z.string().trim().min(1).optional()
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

const optionalProfileStringSchema = z.string().trim().min(1).max(255).optional();

export const enterpriseUserInputSchema = z
  .object({
    department: optionalProfileStringSchema,
    employeeNumber: optionalProfileStringSchema
  })
  .strict();

export const scimUserInputSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    externalId: optionalProfileStringSchema,
    userName: z.string().trim().min(1).max(255),
    name: z
      .object({
        givenName: optionalProfileStringSchema,
        familyName: optionalProfileStringSchema
      })
      .strict()
      .optional(),
    displayName: optionalProfileStringSchema,
    active: z.boolean().default(true),
    emails: z
      .array(
        z
          .object({
            value: z.string().trim().email().max(320),
            type: z.string().trim().min(1).max(64).optional(),
            primary: z.boolean().optional()
          })
          .strict()
      )
      .max(50)
      .optional(),
    [SCIM_ENTERPRISE_USER_SCHEMA]: enterpriseUserInputSchema.optional()
  })
  .strict();

export type ScimUserInput = z.infer<typeof scimUserInputSchema>;

export const scimGroupMemberSchema = z
  .object({
    value: z.string().uuid(),
    "$ref": z.string().url().optional(),
    display: z.string().trim().min(1).max(255).optional()
  })
  .strict();

export type ScimGroupMember = z.infer<typeof scimGroupMemberSchema>;

export const scimGroupInputSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    displayName: z.string().trim().min(1).max(255),
    members: z.array(scimGroupMemberSchema).max(10_000).optional()
  })
  .strict();

export type ScimGroupInput = z.infer<typeof scimGroupInputSchema>;

export const scimPatchRequestSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    Operations: z
      .array(
        z
          .object({
            op: z.string().trim().toLowerCase().pipe(z.enum(["add", "remove", "replace"])),
            path: z.string().trim().min(1).max(512).optional(),
            value: z.unknown().optional()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict();

export type ScimPatchRequest = z.infer<typeof scimPatchRequestSchema>;

export interface ScimListResponse<Resource> {
  schemas: [typeof SCIM_LIST_RESPONSE_SCHEMA];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: Resource[];
}

export function createScimListResponse<Resource>(
  resources: Resource[],
  totalResults: number,
  startIndex: number
): ScimListResponse<Resource> {
  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources
  };
}

export const serviceProviderConfig = {
  schemas: [SCIM_SERVICE_PROVIDER_CONFIG_SCHEMA],
  documentationUri: "https://www.rfc-editor.org/rfc/rfc7644",
  patch: { supported: true },
  bulk: { supported: false },
  filter: { supported: true, maxResults: 100 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "Bearer token",
      description: "A static bearer token for local development.",
      primary: true
    }
  ]
} as const;

const metaAttribute = {
  name: "meta",
  type: "complex",
  multiValued: false,
  description: "Metadata maintained by the SCIM service.",
  required: false,
  mutability: "readOnly",
  returned: "default"
} as const;

export const userSchema = {
  schemas: [SCIM_SCHEMA_SCHEMA],
  id: SCIM_USER_SCHEMA,
  name: "User",
  description: "Core SCIM User schema.",
  attributes: [
    {
      name: "userName",
      type: "string",
      multiValued: false,
      description: "Unique user name for the resource.",
      required: true,
      caseExact: false,
      mutability: "readWrite",
      returned: "default",
      uniqueness: "server"
    },
    {
      name: "externalId",
      type: "string",
      multiValued: false,
      description: "Stable client-provided external identifier.",
      required: false,
      caseExact: true,
      mutability: "readWrite",
      returned: "default",
      uniqueness: "server"
    },
    {
      name: "name",
      type: "complex",
      multiValued: false,
      description: "The user's name.",
      required: false,
      mutability: "readWrite",
      returned: "default",
      subAttributes: [
        {
          name: "givenName",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
          returned: "default"
        },
        {
          name: "familyName",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
          returned: "default"
        }
      ]
    },
    {
      name: "displayName",
      type: "string",
      multiValued: false,
      required: false,
      mutability: "readWrite",
      returned: "default"
    },
    {
      name: "active",
      type: "boolean",
      multiValued: false,
      description: "Whether the user can access the demo application.",
      required: false,
      mutability: "readWrite",
      returned: "default"
    },
    metaAttribute
  ]
} as const;

export const groupSchema = {
  schemas: [SCIM_SCHEMA_SCHEMA],
  id: SCIM_GROUP_SCHEMA,
  name: "Group",
  description: "Core SCIM Group schema.",
  attributes: [
    {
      name: "displayName",
      type: "string",
      multiValued: false,
      description: "Unique display name for the group.",
      required: true,
      caseExact: false,
      mutability: "readWrite",
      returned: "default",
      uniqueness: "server"
    },
    {
      name: "members",
      type: "complex",
      multiValued: true,
      description: "User resources that belong to this group.",
      required: false,
      mutability: "readWrite",
      returned: "default",
      subAttributes: [
        {
          name: "value",
          type: "string",
          multiValued: false,
          required: true,
          mutability: "immutable",
          returned: "default"
        },
        {
          name: "$ref",
          type: "reference",
          referenceTypes: ["User"],
          multiValued: false,
          required: false,
          mutability: "readOnly",
          returned: "default"
        }
      ]
    },
    metaAttribute
  ]
} as const;

export const enterpriseUserSchema = {
  schemas: [SCIM_SCHEMA_SCHEMA],
  id: SCIM_ENTERPRISE_USER_SCHEMA,
  name: "EnterpriseUser",
  description: "Enterprise User extension for department and employee number.",
  attributes: [
    {
      name: "department",
      type: "string",
      multiValued: false,
      required: false,
      mutability: "readWrite",
      returned: "default"
    },
    {
      name: "employeeNumber",
      type: "string",
      multiValued: false,
      required: false,
      mutability: "readWrite",
      returned: "default"
    }
  ]
} as const;

export const resourceTypes = [
  {
    schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
    id: "User",
    name: "User",
    description: "User account",
    endpoint: "/Users",
    schema: SCIM_USER_SCHEMA,
    schemaExtensions: [{ schema: SCIM_ENTERPRISE_USER_SCHEMA, required: false }]
  },
  {
    schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
    id: "Group",
    name: "Group",
    description: "Group",
    endpoint: "/Groups",
    schema: SCIM_GROUP_SCHEMA
  }
] as const;

export const schemas = [userSchema, enterpriseUserSchema, groupSchema] as const;