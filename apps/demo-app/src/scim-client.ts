import { z } from "zod";

export interface ScimDirectoryUser {
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  active: boolean;
}

export interface ScimDirectoryClient {
  findUsersByExternalId(externalId: string): Promise<ScimDirectoryUser[]>;
}

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class ScimDirectoryUnavailableError extends Error {
  public constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "ScimDirectoryUnavailableError";
  }
}

const scimUserSchema = z
  .object({
    id: z.string().uuid(),
    externalId: z.string().min(1).optional(),
    userName: z.string().min(1),
    displayName: z.string().min(1).optional(),
    active: z.boolean()
  })
  .passthrough();

const scimListResponseSchema = z
  .object({
    totalResults: z.number().int().nonnegative(),
    Resources: z.array(scimUserSchema)
  })
  .passthrough();

function escapeScimFilterString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export class HttpScimDirectoryClient implements ScimDirectoryClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
    private readonly fetchImplementation: FetchImplementation = (input, init) => fetch(input, init)
  ) {}

  public async findUsersByExternalId(externalId: string): Promise<ScimDirectoryUser[]> {
    const url = new URL("Users", `${this.baseUrl}/`);
    url.searchParams.set("filter", `externalId eq "${escapeScimFilterString(externalId)}"`);

    let response: Response;

    try {
      response = await this.fetchImplementation(url, {
        headers: { authorization: `Bearer ${this.bearerToken}` }
      });
    } catch {
      throw new ScimDirectoryUnavailableError("The SCIM directory could not be reached.");
    }

    if (!response.ok) {
      throw new ScimDirectoryUnavailableError("The SCIM directory rejected the user lookup.", response.status);
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      throw new ScimDirectoryUnavailableError("The SCIM directory returned an invalid response.", response.status);
    }

    const parsed = scimListResponseSchema.safeParse(payload);

    if (!parsed.success) {
      throw new ScimDirectoryUnavailableError("The SCIM directory returned an unexpected response.", response.status);
    }

    return parsed.data.Resources.map((user) => ({
      id: user.id,
      userName: user.userName,
      active: user.active,
      ...(user.externalId === undefined ? {} : { externalId: user.externalId }),
      ...(user.displayName === undefined ? {} : { displayName: user.displayName })
    }));
  }
}
