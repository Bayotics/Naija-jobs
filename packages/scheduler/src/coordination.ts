import { and, eq, gt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '@job-intel/db';
import { schema } from '@job-intel/db';

/**
 * Coordination between instances.
 *
 * Two mechanisms, both leases, both in Postgres.
 *
 * **Leader election** (Part 39) stops several scheduler instances from each
 * creating the same schedule. Idempotency keys already make duplicate *tasks*
 * impossible, so leadership is an efficiency measure rather than a correctness
 * one — which is a good position to be in, because it means a brief split-brain
 * during a failover costs some wasted queries rather than duplicate scans.
 *
 * **Shared token buckets** (Parts 17–19) enforce rate limits across workers. An
 * in-process limiter answers "have I exceeded this limit?", and once there is
 * more than one worker that is the wrong question: three workers each politely
 * observing ten requests a minute make thirty.
 */

// ── Leader election (Part 39) ───────────────────────────────────────────────

export interface LeadershipResult {
  acquired: boolean;
  holder: string;
  expiresAt: Date;
  /** Increments on every change of leadership. */
  fencingToken: number;
  reason: string;
}

export class CoordinationService {
  constructor(private readonly db: Database) {}

  /**
   * Takes or renews a named lease.
   *
   * One statement, and it has to be: acquisition is a compare-and-set against
   * either "no current holder" or "the lease has expired", and splitting it
   * into a read and a write reintroduces exactly the race leadership exists to
   * prevent.
   */
  async acquireLease(
    name: string,
    holder: string,
    durationMs: number,
    now = new Date(),
  ): Promise<LeadershipResult> {
    const expiresAt = new Date(now.getTime() + durationMs);

    const [row] = await this.db
      .insert(schema.coordinationLeases)
      .values({
        name,
        holder,
        acquiredAt: now,
        renewedAt: now,
        expiresAt,
        fencingToken: 1,
      })
      .onConflictDoUpdate({
        target: schema.coordinationLeases.name,
        set: {
          holder,
          renewedAt: now,
          expiresAt,
          /*
           * The token advances only when leadership actually changes hands. A
           * renewal by the incumbent leaves it alone, so a rising token means
           * "someone else took over" rather than "time passed".
           */
          fencingToken: sql`CASE WHEN ${schema.coordinationLeases.holder} = ${holder}
                                 THEN ${schema.coordinationLeases.fencingToken}
                                 ELSE ${schema.coordinationLeases.fencingToken} + 1 END`,
          acquiredAt: sql`CASE WHEN ${schema.coordinationLeases.holder} = ${holder}
                               THEN ${schema.coordinationLeases.acquiredAt}
                               ELSE ${now} END`,
        },
        /*
         * The guard. An update happens only when this caller already holds the
         * lease, or when the current lease has run out. Anything else leaves
         * the incumbent untouched and returns no row.
         */
        setWhere: or(
          eq(schema.coordinationLeases.holder, holder),
          lte(schema.coordinationLeases.expiresAt, now),
        ),
      })
      .returning();

    if (row) {
      return {
        acquired: true,
        holder,
        expiresAt: row.expiresAt,
        fencingToken: row.fencingToken,
        reason: 'Lease held.',
      };
    }

    const [current] = await this.db
      .select()
      .from(schema.coordinationLeases)
      .where(eq(schema.coordinationLeases.name, name))
      .limit(1);

    return {
      acquired: false,
      holder: current?.holder ?? 'unknown',
      expiresAt: current?.expiresAt ?? now,
      fencingToken: current?.fencingToken ?? 0,
      reason: `Held by ${current?.holder ?? 'another instance'} until ${current?.expiresAt.toISOString() ?? 'unknown'}.`,
    };
  }

  /** Whether this holder currently owns an unexpired lease. */
  async holdsLease(name: string, holder: string, now = new Date()): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.coordinationLeases.name })
      .from(schema.coordinationLeases)
      .where(
        and(
          eq(schema.coordinationLeases.name, name),
          eq(schema.coordinationLeases.holder, holder),
          gt(schema.coordinationLeases.expiresAt, now),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * Gives up a lease immediately.
   *
   * Called on graceful shutdown so a successor takes over in milliseconds
   * rather than waiting out the remaining lease. The expiry path still exists
   * for the ungraceful case; this is the optimisation, not the mechanism.
   */
  async releaseLease(name: string, holder: string, now = new Date()): Promise<boolean> {
    const released = await this.db
      .update(schema.coordinationLeases)
      .set({ expiresAt: now })
      .where(and(eq(schema.coordinationLeases.name, name), eq(schema.coordinationLeases.holder, holder)))
      .returning({ name: schema.coordinationLeases.name });

    return released.length > 0;
  }

  // ── Shared rate limiting (Parts 17–19) ────────────────────────────────────

  /**
   * Takes tokens from a shared bucket, refilling by elapsed time first.
   *
   * A token bucket rather than a fixed window because bursts are legitimate and
   * a fixed window is not: a source allowing sixty requests a minute is fine
   * with ten in one second followed by a pause, and a fixed-window counter
   * either forbids that or allows a hundred and twenty across a boundary.
   *
   * `blockedUntil` overrides everything. When a source has answered 429 with a
   * `Retry-After`, no tokens are issued before that time no matter what the
   * arithmetic says — the source has told us the answer.
   */
  async takeTokens(
    key: string,
    input: {
      count?: number;
      capacity: number;
      refillPerSecond: number;
      now?: Date;
    },
  ): Promise<{ allowed: boolean; tokensLeft: number; retryAfterMs: number; reason: string }> {
    const now = input.now ?? new Date();
    const count = input.count ?? 1;
    const refillMilli = Math.max(1, Math.round(input.refillPerSecond * 1000));

    const [existing] = await this.db
      .select()
      .from(schema.rateLimitBuckets)
      .where(eq(schema.rateLimitBuckets.key, key))
      .limit(1);

    if (!existing) {
      const starting = Math.max(0, input.capacity - count);

      await this.db
        .insert(schema.rateLimitBuckets)
        .values({
          key,
          tokens: starting,
          capacity: input.capacity,
          refillMilliPerSecond: refillMilli,
          lastRefillAt: now,
        })
        .onConflictDoNothing();

      return {
        allowed: input.capacity >= count,
        tokensLeft: starting,
        retryAfterMs: 0,
        reason: 'New bucket.',
      };
    }

    if (existing.blockedUntil && existing.blockedUntil > now) {
      return {
        allowed: false,
        tokensLeft: existing.tokens,
        retryAfterMs: existing.blockedUntil.getTime() - now.getTime(),
        reason: `The source asked us to wait until ${existing.blockedUntil.toISOString()}.`,
      };
    }

    const elapsedMs = Math.max(0, now.getTime() - existing.lastRefillAt.getTime());
    const refilled = Math.floor((elapsedMs * existing.refillMilliPerSecond) / 1_000_000);
    const available = Math.min(existing.capacity, existing.tokens + refilled);

    if (available < count) {
      const shortfall = count - available;
      const retryAfterMs = Math.ceil((shortfall * 1_000_000) / existing.refillMilliPerSecond);

      /*
       * The refill is still written even though the request was refused, so the
       * next caller does not recompute the same elapsed window from the same
       * stale timestamp.
       */
      await this.db
        .update(schema.rateLimitBuckets)
        .set({ tokens: available, lastRefillAt: now })
        .where(eq(schema.rateLimitBuckets.key, key));

      return {
        allowed: false,
        tokensLeft: available,
        retryAfterMs,
        reason: `Bucket ${key} has ${available} of ${count} tokens needed.`,
      };
    }

    const remaining = available - count;

    /*
     * The conditional `WHERE` is the concurrency guard. Two workers reading the
     * same token count and both writing their own answer would let both through;
     * requiring the row to still hold the tokens we counted means the loser
     * writes nothing and is refused.
     */
    const updated = await this.db
      .update(schema.rateLimitBuckets)
      .set({ tokens: remaining, lastRefillAt: now })
      .where(
        and(
          eq(schema.rateLimitBuckets.key, key),
          sql`${schema.rateLimitBuckets.tokens} + floor((extract(epoch from (${now} - ${schema.rateLimitBuckets.lastRefillAt})) * ${existing.refillMilliPerSecond}) / 1000) >= ${count}`,
        ),
      )
      .returning({ key: schema.rateLimitBuckets.key });

    if (updated.length === 0) {
      return {
        allowed: false,
        tokensLeft: 0,
        retryAfterMs: Math.ceil(1_000_000 / existing.refillMilliPerSecond),
        reason: 'Another worker took the last tokens.',
      };
    }

    return { allowed: true, tokensLeft: remaining, retryAfterMs: 0, reason: 'Allowed.' };
  }

  /** Records a `Retry-After`, so every worker waits (Part 25). */
  async blockUntil(key: string, until: Date, capacity = 10, refillPerSecond = 1): Promise<void> {
    await this.db
      .insert(schema.rateLimitBuckets)
      .values({
        key,
        tokens: 0,
        capacity,
        refillMilliPerSecond: Math.max(1, Math.round(refillPerSecond * 1000)),
        lastRefillAt: new Date(),
        blockedUntil: until,
      })
      .onConflictDoUpdate({
        target: schema.rateLimitBuckets.key,
        set: { blockedUntil: until },
      });
  }

  async bucketState(key: string) {
    const [row] = await this.db
      .select()
      .from(schema.rateLimitBuckets)
      .where(eq(schema.rateLimitBuckets.key, key))
      .limit(1);

    return row ?? null;
  }
}
