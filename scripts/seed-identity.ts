/**
 * The fixed, deterministic identity used by both the seed generator
 * (scripts/generate-seed.ts) and the local owner provisioner
 * (scripts/provision-owner.ts).
 *
 * Extracted into its own module so the seed's owner UUID has exactly one
 * definition. `npm run auth:reset-local` creates a real, login-capable
 * GoTrue user at this same id *before* applying supabase/seed.sql, so
 * every seeded financial row attaches to the account that actually logs
 * in. A second, drifting copy of this UUID would silently split the
 * seeded data away from the real user.
 */
import { createHash } from "node:crypto";

// Deterministic UUID mapping — fixed per fixture slug, stable across
// regenerations. Not a real UUIDv5 implementation, just a stable hash
// formatted with valid version/variant nibbles.
export function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(`personal-finance-dashboard-seed:${seed}`).digest("hex");
  const hex = hash.slice(0, 32).split("");
  hex[12] = "4"; // version 4 nibble
  const variantChars = "89ab";
  hex[16] = variantChars[parseInt(hash[16], 16) % 4];
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
}

const idCache = new Map<string, string>();

export function uuidFor(slug: string): string {
  let id = idCache.get(slug);
  if (!id) {
    id = deterministicUuid(slug);
    idCache.set(slug, id);
  }
  return id;
}

export const SEED_USER_SLUG = "seed-user";

/** The one owner id every seeded user-owned row belongs to. */
export const SEED_USER_ID = uuidFor(SEED_USER_SLUG);
