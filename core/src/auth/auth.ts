/**
 * Who is calling the core, and what they may do.
 *
 * Staff sign in through Neon Auth (Managed Better Auth) and send its JWT as `Authorization: Bearer`.
 * The iMessage adapter and the Fetch.ai agent send their own service tokens. Staff roles come from
 * the STAFF_ALLOWLIST, not from the token, so a valid Neon account alone grants nothing.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { RequirementKind } from "../types.ts";

export const STAFF_ROLES = ["coordinator", "nurse", "surgeon", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffEntry {
  /** Neon Auth user id or email, matched against the token's `sub` / `email`. */
  match: { userId?: string; email?: string };
  role: StaffRole;
  name: string;
  /** ASI:One sender address linked to this person, so the agent can act for them. */
  asiSender?: string;
}

export type Identity =
  | { kind: "staff"; role: StaffRole; name: string; userId: string }
  | { kind: "service"; service: "imessage" }
  | { kind: "service"; service: "agent"; onBehalfOf: { role: StaffRole; name: string } | null }
  /** Auth is off: local development and offline demos. Actors come from the request body as before. */
  | { kind: "open" };

export type Permission =
  | "read"
  | "record_check"
  | "requirement_action"
  | "clinical_requirement_action"
  | "task_write"
  | "inbound_simulated"
  | "inbound_imessage"
  | "outbox"
  | "outreach_retry"
  | "demo_reset";

/** Verifies a bearer JWT and returns its claims, or throws. Injected so tests need no network. */
export type TokenVerifier = (token: string) => Promise<JWTPayload>;

export interface AuthConfig {
  verifyToken: TokenVerifier;
  staff: StaffEntry[];
  /** Service tokens. Missing means that service cannot authenticate. */
  imessageToken?: string;
  agentToken?: string;
  /** Allow an email match when the token says the email is unverified. Off by default. */
  allowUnverifiedEmail?: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

const CLINICAL_KINDS: readonly RequirementKind[] = ["lab", "medication", "health"];
const CLINICAL_ROLES: readonly StaffRole[] = ["nurse", "surgeon", "admin"];

export function isClinicalKind(kind: RequirementKind): boolean {
  return CLINICAL_KINDS.includes(kind);
}

/** Throws 403 unless the identity holds the permission. `open` holds everything. */
export function requirePermission(identity: Identity, permission: Permission): void {
  if (!allowed(identity, permission)) {
    throw new AuthError(403, `${describeIdentity(identity)} is not allowed to do this (${permission.replaceAll("_", " ")})`);
  }
}

function allowed(identity: Identity, permission: Permission): boolean {
  switch (identity.kind) {
    case "open":
      return true;
    case "staff":
      return staffAllowed(identity.role, permission);
    case "service":
      if (identity.service === "imessage") {
        return permission === "inbound_imessage" || permission === "outbox";
      }
      // Anyone can message the agent in ASI:One, so it acts only for a linked staff member, within that person's role.
      if (!identity.onBehalfOf) return false;
      return (
        (permission === "read" ||
          permission === "task_write" ||
          permission === "requirement_action" ||
          permission === "clinical_requirement_action") &&
        staffAllowed(identity.onBehalfOf.role, permission)
      );
  }
}

function staffAllowed(role: StaffRole, permission: Permission): boolean {
  switch (permission) {
    case "read":
    case "record_check":
    case "requirement_action":
    case "task_write":
    case "inbound_simulated":
    case "outreach_retry":
      return true;
    case "clinical_requirement_action":
      return CLINICAL_ROLES.includes(role);
    case "outbox":
    case "demo_reset":
      return role === "admin";
    case "inbound_imessage":
      return false;
  }
}

/** The audit actor for an identity, e.g. "nurse:Priya" or "nurse:Priya via ASI:One". `null` when auth is off. */
export function actorFor(identity: Identity): string | null {
  switch (identity.kind) {
    case "open":
      return null;
    case "staff":
      return `${identity.role}:${identity.name}`;
    case "service":
      if (identity.service === "imessage") return "imessage";
      return identity.onBehalfOf ? `${identity.onBehalfOf.role}:${identity.onBehalfOf.name} via ASI:One` : "agent";
  }
}

function describeIdentity(identity: Identity): string {
  return actorFor(identity) ?? "caller";
}

/** Constant-time comparison, so a wrong service token does not leak how much of it matched. */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * Resolves the caller from the request headers. Throws 401 for a missing or invalid credential,
 * 403 for a valid Neon account that is not on the staff allowlist.
 */
export async function authenticate(
  config: AuthConfig,
  headers: { authorization?: string; sender?: string },
): Promise<Identity> {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.authorization?.trim() ?? "");
  if (!match) throw new AuthError(401, "Sign in required: send Authorization: Bearer <token>");
  const token = match[1]!;

  if (config.imessageToken && sameToken(token, config.imessageToken)) {
    return { kind: "service", service: "imessage" };
  }
  if (config.agentToken && sameToken(token, config.agentToken)) {
    const sender = headers.sender?.trim();
    const linked = sender ? config.staff.find((s) => s.asiSender === sender) : undefined;
    return { kind: "service", service: "agent", onBehalfOf: linked ? { role: linked.role, name: linked.name } : null };
  }

  let claims: JWTPayload;
  try {
    claims = await config.verifyToken(token);
  } catch {
    throw new AuthError(401, "Session expired or invalid. Sign in again.");
  }
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const emailVerified = claims.emailVerified === true || config.allowUnverifiedEmail === true;
  if (!userId) throw new AuthError(401, "Token has no subject");

  const entry =
    config.staff.find((s) => s.match.userId === userId) ??
    (email && emailVerified ? config.staff.find((s) => s.match.email === email) : undefined);
  if (!entry) {
    const hint = email && !emailVerified ? " Verify your email address first." : "";
    throw new AuthError(403, `This account is not on the ReadyFor staff list.${hint}`);
  }
  return { kind: "staff", role: entry.role, name: entry.name, userId };
}

/**
 * Parses STAFF_ALLOWLIST: entries separated by ";" or newlines, each "who,role,Name[,asiSender]".
 * `who` is an email or "id:<neon user id>". Example:
 *   "dana@example.edu,coordinator,Dana; id:860dc360-...,nurse,Priya,agent1qxyz..."
 */
export function parseStaffAllowlist(raw: string | undefined): StaffEntry[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[;\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      const [who, role, name, asiSender] = line.split(",").map((p) => p.trim());
      if (!who || !role || !name) {
        throw new Error(`STAFF_ALLOWLIST entry ${i + 1} needs "who,role,Name": got "${line}"`);
      }
      if (!(STAFF_ROLES as readonly string[]).includes(role)) {
        throw new Error(`STAFF_ALLOWLIST entry ${i + 1} has role "${role}"; use one of ${STAFF_ROLES.join(", ")}`);
      }
      const entry: StaffEntry = {
        match: who.startsWith("id:") ? { userId: who.slice(3) } : { email: who.toLowerCase() },
        role: role as StaffRole,
        name,
      };
      if (asiSender) entry.asiSender = asiSender;
      return entry;
    });
}

/** Verifies Neon Auth JWTs (EdDSA) against the branch JWKS. Issuer and audience are the Auth URL's origin. */
export function createNeonVerifier(baseUrl: string, jwksUrl?: string): TokenVerifier {
  const origin = new URL(baseUrl).origin;
  const jwks = createRemoteJWKSet(new URL(jwksUrl || `${baseUrl.replace(/\/+$/, "")}/.well-known/jwks.json`));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: origin, audience: origin, algorithms: ["EdDSA"] });
    return payload;
  };
}

/**
 * Builds the auth config from the environment, or `null` when auth is off.
 * Auth is on when NEON_AUTH_BASE_URL is set. AUTH_REQUIRED=1 refuses to start without it.
 */
export function authConfigFromEnv(env: Record<string, string | undefined>): AuthConfig | null {
  const baseUrl = env.NEON_AUTH_BASE_URL?.trim();
  if (!baseUrl) {
    if (env.AUTH_REQUIRED === "1") {
      throw new Error("AUTH_REQUIRED=1 but NEON_AUTH_BASE_URL is not set. Enable Neon Auth and run `neon env pull`.");
    }
    return null;
  }
  const staff = parseStaffAllowlist(env.STAFF_ALLOWLIST);
  if (staff.length === 0) {
    throw new Error("Neon Auth is on but STAFF_ALLOWLIST is empty, so nobody could sign in. Add at least one entry.");
  }
  const config: AuthConfig = {
    verifyToken: createNeonVerifier(baseUrl, env.NEON_AUTH_JWKS_URL?.trim()),
    staff,
    allowUnverifiedEmail: env.AUTH_ALLOW_UNVERIFIED_EMAIL === "1",
  };
  const imessageToken = env.IMESSAGE_SERVICE_TOKEN?.trim();
  const agentToken = env.AGENT_SERVICE_TOKEN?.trim();
  for (const [name, value] of [["IMESSAGE_SERVICE_TOKEN", imessageToken], ["AGENT_SERVICE_TOKEN", agentToken]] as const) {
    if (value && value.length < 32) throw new Error(`${name} must be at least 32 characters (try: openssl rand -hex 32)`);
  }
  if (imessageToken) config.imessageToken = imessageToken;
  if (agentToken) config.agentToken = agentToken;
  return config;
}
