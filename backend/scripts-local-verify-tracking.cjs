// Read-only verification of recent website tracking records. Run with:
//   node --env-file=.env.production scripts-local-verify-tracking.cjs
// Every query runs inside a READ ONLY transaction; Postgres rejects any write.
const { Client } = require('pg');

const short = (s) => (s ? `${String(s).slice(0, 8)}…` : null);

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    const { rows: events } = await client.query(`
      SELECT e.workspace_id, e.event_type, e.occurred_at, e.received_at, e.visitor_id, e.session_id,
             e.payload->>'path' AS path, e.payload->>'url' AS url
      FROM website_events e
      WHERE e.received_at > now() - interval '6 hours'
      ORDER BY e.received_at DESC LIMIT 30`);
    console.log(`\n== website_events (last 6h): ${events.length} rows`);
    console.table(events.map((r) => ({ ws: short(r.workspace_id), type: r.event_type, occurred: r.occurred_at.toISOString(), received: r.received_at.toISOString(), visitor: short(r.visitor_id), session: short(r.session_id), page: r.path ?? r.url })));

    const { rows: counts } = await client.query(`
      SELECT event_type, count(*)::int AS n FROM website_events
      WHERE received_at > now() - interval '6 hours' GROUP BY event_type ORDER BY n DESC`);
    console.log('\n== event counts by type (last 6h)');
    console.table(counts);

    const visitorIds = [...new Set(events.map((r) => r.visitor_id))];
    const sessionIds = [...new Set(events.map((r) => r.session_id))];

    const { rows: visitors } = await client.query(
      `SELECT id, workspace_id, visitor_id, canonical_customer_id, first_seen_at, last_seen_at FROM website_visitors WHERE id = ANY($1)`,
      [visitorIds],
    );
    console.log(`\n== website_visitors referenced: ${visitors.length}`);
    console.table(visitors.map((v) => ({ id: short(v.id), ws: short(v.workspace_id), clientVisitorId: short(v.visitor_id), canonicalCustomer: short(v.canonical_customer_id), firstSeen: v.first_seen_at.toISOString(), lastSeen: v.last_seen_at.toISOString() })));

    const { rows: sessions } = await client.query(
      `SELECT s.id, s.visitor_id, s.session_key, s.started_at, s.last_event_at,
              (SELECT count(*)::int FROM website_events e WHERE e.session_id = s.id) AS events
       FROM website_sessions s WHERE s.id = ANY($1)`,
      [sessionIds],
    );
    console.log(`\n== website_sessions referenced: ${sessions.length}`);
    console.table(sessions.map((s) => ({ id: short(s.id), visitor: short(s.visitor_id), sessionKey: short(s.session_key), started: s.started_at.toISOString(), lastEvent: s.last_event_at.toISOString(), events: s.events })));

    // Integrity: every event's visitor/session exists, same workspace, session belongs to visitor.
    const { rows: [integrity] } = await client.query(`
      SELECT count(*)::int AS checked,
             count(*) FILTER (WHERE v.id IS NULL OR s.id IS NULL)::int AS missing_refs,
             count(*) FILTER (WHERE v.workspace_id <> e.workspace_id OR s.workspace_id <> e.workspace_id)::int AS cross_workspace,
             count(*) FILTER (WHERE s.visitor_id <> e.visitor_id)::int AS session_visitor_mismatch
      FROM website_events e
      LEFT JOIN website_visitors v ON v.id = e.visitor_id
      LEFT JOIN website_sessions s ON s.id = e.session_id
      WHERE e.received_at > now() - interval '6 hours'`);
    console.log('\n== integrity');
    console.table([integrity]);

    const linked = visitors.filter((v) => v.canonical_customer_id).map((v) => v.canonical_customer_id);
    console.log(`\n== identity linkage: ${linked.length}/${visitors.length} visitors linked to a canonical customer`);
    if (linked.length) {
      const { rows: customers } = await client.query(
        `SELECT id, workspace_id FROM canonical_customers WHERE id = ANY($1)`,
        [linked],
      );
      console.table(customers.map((c) => ({ id: short(c.id), ws: short(c.workspace_id) })));
    }

    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
