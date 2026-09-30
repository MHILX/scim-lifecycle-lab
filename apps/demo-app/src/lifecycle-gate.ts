import type { ScimDirectoryClient, ScimDirectoryUser } from "./scim-client.js";

export type LifecycleAccessResult =
  | { status: "allowed"; user: ScimDirectoryUser }
  | { status: "missing" | "ambiguous" | "inactive" };

export async function resolveLifecycleAccess(
  directoryClient: ScimDirectoryClient,
  auth0Subject: string
): Promise<LifecycleAccessResult> {
  const users = await directoryClient.findUsersByExternalId(auth0Subject);
  const mappedUsers = users.filter((user) => user.externalId === auth0Subject);

  if (mappedUsers.length === 0) {
    return { status: "missing" };
  }

  if (mappedUsers.length > 1) {
    return { status: "ambiguous" };
  }

  const user = mappedUsers[0];

  if (user === undefined || !user.active) {
    return { status: "inactive" };
  }

  return { status: "allowed", user };
}
