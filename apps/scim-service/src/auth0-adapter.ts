import { ManagementClient, ManagementError } from "auth0";

export interface LifecycleUser {
  externalId: string | null;
  department: string | null;
  employeeNumber: string | null;
  active: boolean;
}

export interface LifecycleSyncOutcome {
  adapter: "auth0";
  status: "disabled" | "not_mapped" | "not_found" | "synced" | "failed";
  httpStatus?: number;
}

export interface LifecycleSyncAdapter {
  syncUser(user: LifecycleUser, correlationId: string): Promise<LifecycleSyncOutcome>;
}

export interface Auth0ManagementConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
}

export class Auth0LifecycleAdapter implements LifecycleSyncAdapter {
  private readonly pendingSyncs = new Map<string, Promise<LifecycleSyncOutcome>>();

  public constructor(private readonly users: Pick<ManagementClient["users"], "update">) {}

  public syncUser(user: LifecycleUser, correlationId: string): Promise<LifecycleSyncOutcome> {
    if (user.externalId === null) {
      return Promise.resolve({ adapter: "auth0", status: "not_mapped" });
    }

    const subject = user.externalId;
    const previous = this.pendingSyncs.get(subject) ?? Promise.resolve();
    const sync = previous.then(() => this.updateUser(subject, user, correlationId));
    this.pendingSyncs.set(subject, sync);
    void sync.finally(() => {
      if (this.pendingSyncs.get(subject) === sync) {
        this.pendingSyncs.delete(subject);
      }
    });
    return sync;
  }

  private async updateUser(
    subject: string,
    user: LifecycleUser,
    correlationId: string
  ): Promise<LifecycleSyncOutcome> {
    try {
      await this.users.update(subject, {
        blocked: !user.active,
        app_metadata: {
          externalId: user.externalId,
          department: user.department,
          employeeNumber: user.employeeNumber
        }
      }, {
        timeoutInSeconds: 5,
        maxRetries: 2,
        headers: { "x-correlation-id": correlationId }
      });
      return { adapter: "auth0", status: "synced" };
    } catch (error) {
      if (error instanceof ManagementError && error.statusCode === 404) {
        return { adapter: "auth0", status: "not_found", httpStatus: 404 };
      }

      return {
        adapter: "auth0",
        status: "failed",
        ...(error instanceof ManagementError && error.statusCode !== undefined
          ? { httpStatus: error.statusCode }
          : {})
      };
    }
  }
}

export function createAuth0LifecycleAdapter(config?: Auth0ManagementConfig): LifecycleSyncAdapter | undefined {
  if (config === undefined) {
    return undefined;
  }

  const management = new ManagementClient({
    domain: config.domain,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    timeoutInSeconds: 5,
    maxRetries: 2,
    logging: { silent: true }
  });
  return new Auth0LifecycleAdapter(management.users);
}