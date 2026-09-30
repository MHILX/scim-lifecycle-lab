import { z } from "zod";

const environmentSchema = z.object({
  DEMO_APP_HOST: z.string().trim().min(1).default("127.0.0.1"),
  DEMO_APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DEMO_APP_BASE_URL: z.string().url(),
  SCIM_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  SCIM_BEARER_TOKEN: z.string().min(16, "SCIM_BEARER_TOKEN must be at least 16 characters."),
  AUTH0_DOMAIN: z.string().trim().regex(/^[a-z0-9.-]+$/i, "AUTH0_DOMAIN must be a tenant or custom domain."),
  AUTH0_CLIENT_ID: z.string().trim().min(1),
  AUTH0_CLIENT_SECRET: z.string().trim().min(1),
  AUTH0_SESSION_SECRET: z.string().min(32, "AUTH0_SESSION_SECRET must be at least 32 characters."),
  AUTH0_CALLBACK_URL: z.string().url(),
  AUTH0_LOGOUT_URL: z.string().url()
});

export interface DemoAppConfig {
  host: string;
  port: number;
  baseUrl: string;
  scimBaseUrl: string;
  scimBearerToken: string;
  auth0IssuerBaseUrl: string;
  auth0ClientId: string;
  auth0ClientSecret: string;
  auth0SessionSecret: string;
}

function isLocalHost(url: URL): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";

  if (url.pathname === "/") {
    url.pathname = "";
  }

  return url.toString().replace(/\/$/, "");
}

function assertSecureOutsideLocalhost(name: string, value: string): void {
  const url = new URL(value);

  if (url.protocol !== "https:" && !isLocalHost(url)) {
    throw new Error(`${name} must use HTTPS outside localhost.`);
  }
}

export function loadDemoAppConfig(environment: NodeJS.ProcessEnv = process.env): DemoAppConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join(" ");
    throw new Error(`Invalid demo app configuration: ${details}`);
  }

  const baseUrl = normalizeUrl(parsed.data.DEMO_APP_BASE_URL);
  const scimBaseUrl = normalizeUrl(parsed.data.SCIM_BASE_URL);
  const callbackUrl = normalizeUrl(parsed.data.AUTH0_CALLBACK_URL);
  const logoutUrl = normalizeUrl(parsed.data.AUTH0_LOGOUT_URL);

  assertSecureOutsideLocalhost("DEMO_APP_BASE_URL", baseUrl);
  assertSecureOutsideLocalhost("SCIM_BASE_URL", scimBaseUrl);

  if (callbackUrl !== `${baseUrl}/callback`) {
    throw new Error("AUTH0_CALLBACK_URL must exactly match DEMO_APP_BASE_URL followed by /callback.");
  }

  if (logoutUrl !== baseUrl) {
    throw new Error("AUTH0_LOGOUT_URL must exactly match DEMO_APP_BASE_URL.");
  }

  return {
    host: parsed.data.DEMO_APP_HOST,
    port: parsed.data.DEMO_APP_PORT,
    baseUrl,
    scimBaseUrl,
    scimBearerToken: parsed.data.SCIM_BEARER_TOKEN,
    auth0IssuerBaseUrl: `https://${parsed.data.AUTH0_DOMAIN}`,
    auth0ClientId: parsed.data.AUTH0_CLIENT_ID,
    auth0ClientSecret: parsed.data.AUTH0_CLIENT_SECRET,
    auth0SessionSecret: parsed.data.AUTH0_SESSION_SECRET
  };
}
