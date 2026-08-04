export const CORE_API_URL = (process.env.CORE_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
export const CORE_ORG_ID = process.env.CORE_ORG_ID ?? "acme";
const secret = (raw: string | undefined): string | undefined => (raw?.trim() ? raw : undefined);

export const CORE_SIGNING_SECRET = secret(process.env.CORE_SIGNING_SECRET);
export const PORTAL_IDENTITY_SECRET = secret(process.env.PORTAL_IDENTITY_SECRET) ?? CORE_SIGNING_SECRET;
if (!secret(process.env.PORTAL_IDENTITY_SECRET) && CORE_SIGNING_SECRET) {
  console.warn(
    "[chassis] PORTAL_IDENTITY_SECRET unset — signing portal identity with CORE_SIGNING_SECRET (dev fallback)",
  );
}

export function portFromEnv(fallback: number): number {
  return Number(process.env.PORT ?? fallback);
}

// Host to bind the listening socket to. Unset means every interface, which is
// what a container deployment wants; a self-hosted install that puts a front
// door (portal, or an identity shim) ahead of a surface sets 127.0.0.1 so the
// raw surface cannot be reached around it.
export function bindHostFromEnv(): string | undefined {
  return process.env.BIND_HOST?.trim() || undefined;
}
