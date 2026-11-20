import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { scrubSensitive } from '../common/logging/scrub-sensitive';
import { scrubSentryEvent } from '../common/observability/sentry';
import { redactPgMessage, toSafeDbError } from './safe-db-error';

const EMAIL = 'opal.guest@example.com';
const PHONE = '+919876543210';

/** Shaped like pg's DatabaseError (pg-protocol): Error + code/severity/detail/where/internalQuery/constraint. */
function pgError(message: string, extra: Record<string, unknown>) {
  const error = Object.assign(new Error(message), { severity: 'ERROR', ...extra });
  error.stack = `error: ${message}\n    at Parser.parseErrorMessage (pg-protocol/dist/parser.js:1:1)`;
  return error;
}

describe('toSafeDbError', () => {
  it('unwraps DrizzleQueryError to the driver error: no SQL, no params, code/constraint kept', () => {
    const cause = pgError(
      'duplicate key value violates unique constraint "commerce_customers_email_unique"',
      {
        code: '23505',
        constraint: 'commerce_customers_email_unique',
        table: 'commerce_customers',
        detail: `Key (workspace_id, email)=(ws_1, ${EMAIL}) already exists.`,
        where: `SQL statement "insert … values ('${EMAIL}')"`,
        internalQuery: `select * from commerce_customers where email = '${EMAIL}'`,
      },
    );
    const wrapped = new DrizzleQueryError(
      'insert into "commerce_customers" ("email","phone") values ($1, $2)',
      [EMAIL, PHONE],
      cause,
    );
    expect(wrapped.message).toContain(EMAIL); // the leak this module exists to prevent

    const safe = toSafeDbError(wrapped) as typeof cause & Record<string, unknown>;

    expect(safe).toBe(cause);
    expect(safe).not.toBeInstanceOf(DrizzleQueryError);
    expect(safe.code).toBe('23505');
    expect(safe.constraint).toBe('commerce_customers_email_unique');
    expect(safe.table).toBe('commerce_customers');
    expect(safe.message).toBe(
      'duplicate key value violates unique constraint "commerce_customers_email_unique"',
    );
    expect(safe.detail).toBe('Key (workspace_id, email)=([redacted]) already exists.');
    expect(safe.where).toBeUndefined();
    expect(safe.internalQuery).toBeUndefined();
    const everything = `${safe.message} ${safe.stack} ${String(safe)} ${JSON.stringify(safe)} ${safe.detail}`;
    for (const leak of [EMAIL, PHONE, 'insert into', 'Failed query', 'params:'])
      expect(everything).not.toContain(leak);
  });

  it('redacts input values Postgres quotes into messages, keeping object names', () => {
    expect(redactPgMessage(`invalid input syntax for type uuid: "${EMAIL}"`)).toBe(
      'invalid input syntax for type uuid: "[redacted]"',
    );
    expect(redactPgMessage(`invalid input value for enum status: "${EMAIL}"`)).toBe(
      'invalid input value for enum status: "[redacted]"',
    );
    expect(redactPgMessage(`value "${PHONE}" is out of range for type integer`)).toBe(
      'value "[redacted]" is out of range for type integer',
    );
    expect(
      redactPgMessage(
        'null value in column "email" of relation "commerce_customers" violates not-null constraint',
      ),
    ).toBe(
      'null value in column "email" of relation "commerce_customers" violates not-null constraint',
    );
  });

  it('redacts "Failing row contains (…)" details and rewrites the stack', () => {
    const cause = pgError(`invalid input syntax for type uuid: "${EMAIL}"`, {
      code: '22P02',
      detail: `Failing row contains (1, ${EMAIL}, ${PHONE}).`,
    });
    const safe = toSafeDbError(
      new DrizzleQueryError('select $1::uuid', [EMAIL], cause),
    ) as typeof cause & { detail: string };
    expect(safe.detail).toBe('Failing row contains ([redacted]).');
    expect(safe.stack).not.toContain(EMAIL);
    expect(safe.stack).toContain('invalid input syntax for type uuid: "[redacted]"');
  });

  it('passes non-database errors through unchanged; a wrapper without a cause becomes a generic error', () => {
    const connection = new Error('Connection terminated unexpectedly');
    expect(toSafeDbError(new DrizzleQueryError('select 1', [], connection))).toBe(connection);
    const app = new Error('not a db error');
    expect(toSafeDbError(app)).toBe(app);
    const bare = toSafeDbError(new DrizzleQueryError('select $1', [EMAIL])) as Error;
    expect(bare.message).toBe('Database query failed.');
  });
});

describe('backstops for any wrapper that escapes', () => {
  const raw = `Failed query: insert into "customers" ("email") values ($1)\nparams: ${EMAIL},${PHONE}`;

  it('scrubSensitive drops everything from "Failed query:" on', () => {
    const scrubbed = scrubSensitive(`processing failed: ${raw}`);
    expect(scrubbed).toBe('processing failed: Failed query: [redacted-sql]');
  });

  it('Sentry events are scrubbed (message and every exception value, incl. linked causes)', () => {
    const event = scrubSentryEvent({
      message: raw,
      exception: { values: [{ value: raw }, { value: `contact ${EMAIL}` }] },
    });
    expect(JSON.stringify(event)).not.toContain(EMAIL);
    expect(JSON.stringify(event)).not.toContain(PHONE);
    expect(JSON.stringify(event)).not.toContain('insert into');
  });
});
