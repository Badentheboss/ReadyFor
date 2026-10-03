import type { Context } from "hono";
import type { Channel, Owner } from "../types.ts";
import { badRequest } from "./errors.ts";

export const OWNERS: readonly Owner[] = ["coordinator", "nurse", "surgeon", "patient"];
export const CHANNELS: readonly Channel[] = ["imessage", "simulated", "asione"];

export type Body = Record<string, unknown>;

export async function readJsonObject(c: Context): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object");
  }
  return parsed as Body;
}

export function requireString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`"${field}" is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(body: Body, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`"${field}" must be a string`);
  return value;
}

export function requireOneOf<T extends string>(body: Body, field: string, allowed: readonly T[]): T {
  const value = body[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`"${field}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalOneOf<T extends string>(body: Body, field: string, allowed: readonly T[]): T | undefined {
  return body[field] === undefined || body[field] === null ? undefined : requireOneOf(body, field, allowed);
}
