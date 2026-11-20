import { DrizzleQueryError } from 'drizzle-orm';
import { PgPreparedQuery } from 'drizzle-orm/pg-core';

/**
 * Database errors must never carry SQL text, parameter values or row data (customer email, names, phones,
 * encrypted credentials) into logs, Sentry, API responses, stored error columns (webhook events, automation runs,
 * AI action failures) or AI tool results — every one of those sinks reads `error.message`/`String(error)`.
 *
 * drizzle-orm ≥ 0.44 wraps every query failure in a `DrizzleQueryError` whose message is
 * `Failed query: <sql>\nparams: <values>`. This module restores what callers saw before (the driver's own error,
 * with `code`, `constraint`, `table`, `column`, `severity` intact — so unique-violation/deadlock checks keep
 * working) and additionally strips the value-bearing parts of Postgres errors.
 */

type PgLikeError = Error & {
  code?: string;
  severity?: string;
  detail?: string;
  where?: string;
  internalQuery?: string;
};

const REDACTED = '[redacted]';

function isPgError(error: unknown): error is PgLikeError {
  return error instanceof Error && typeof (error as PgLikeError).code === 'string' && typeof (error as PgLikeError).severity === 'string';
}

/**
 * Postgres puts input values in double quotes after ": " (`invalid input syntax for type uuid: "x"`) or after
 * `value ` (`value "x" is out of range`). Object names (`constraint "x"`, `relation "x"`) are kept for diagnostics.
 */
export function redactPgMessage(message: string): string {
  return message.replace(/(: |value )"(?:[^"\\]|\\.)*"/g, `$1"${REDACTED}"`);
}

/** `Key (email)=(a@b.c) already exists.` → keeps the column list, drops the values; also `Failing row contains (…)`. */
function redactPgDetail(detail: string): string {
  return redactPgMessage(detail)
    .replace(/\)=\((.*?)\)(?=[ .,]|$)/g, `)=(${REDACTED})`)
    .replace(/Failing row contains \(.*\)/g, `Failing row contains (${REDACTED})`);
}

/** Returns the error a caller should see: the driver error (never the drizzle wrapper), with values removed. */
export function toSafeDbError(error: unknown): unknown {
  const inner = error instanceof DrizzleQueryError ? error.cause : error;
  if (inner === undefined || inner instanceof DrizzleQueryError) {
    return new Error('Database query failed.');
  }
  if (isPgError(inner)) {
    const original = inner.message;
    inner.message = redactPgMessage(original);
    if (inner.stack) inner.stack = inner.stack.replace(original, inner.message);
    if (inner.detail) inner.detail = redactPgDetail(inner.detail);
    delete inner.where;
    delete inner.internalQuery;
  }
  return inner;
}

let installed = false;

/**
 * Wraps the one choke point every pg-core query (select/insert/update/delete/execute, BEGIN/COMMIT) runs through.
 * Fails loudly if a future drizzle-orm moves it, rather than silently letting SQL parameters through again.
 */
export function installSafeDbErrors(): void {
  if (installed) return;
  const proto = PgPreparedQuery.prototype as unknown as { queryWithCache?: (...args: unknown[]) => Promise<unknown> };
  const original = proto.queryWithCache;
  if (typeof original !== 'function') {
    throw new Error('drizzle-orm internals changed: PgPreparedQuery.prototype.queryWithCache is missing — database errors would expose SQL parameters.');
  }
  proto.queryWithCache = async function (this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (error) {
      throw toSafeDbError(error);
    }
  };
  installed = true;
}

installSafeDbErrors();
