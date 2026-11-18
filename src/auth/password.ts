import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing for accounts (docs/auth-implementation-plan.md, "Decisions"): Argon2id with the
 * library's defaults, which are the OWASP minimum: memoryCost 19456 KiB (19 MiB), timeCost 2,
 * parallelism 1. The defaults are not repeated here, so a library upgrade that raises them applies to
 * new hashes; the parameters are stored in each hash, so old hashes keep verifying.
 *
 * Both functions run on the libuv thread pool, not on the event loop.
 */

/**
 * `Algorithm.Argon2id`. The library declares `Algorithm` as a `const enum`, which `verbatimModuleSyntax`
 * does not let this repo import, so its value is spelled out. It is also the library's default.
 */
const ARGON2ID = 2;

/** A PHC string (`$argon2id$v=19$m=19456,t=2,p=1$…`) with a random salt. The password is hashed as given. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID });
}

/** True when `password` matches `hash`. A stored value that is not a valid hash is a mismatch, not an error. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await verify(hash, password);
  } catch {
    return false;
  }
}
