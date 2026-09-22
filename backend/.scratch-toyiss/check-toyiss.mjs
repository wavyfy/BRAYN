import pg from 'pg';
import fs from 'node:fs';

const envText = fs.readFileSync('D:/PROJECTS/BRAYN/backend/.env', 'utf8');
const line = envText.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
const databaseUrl = line.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');

const client = new pg.Client({ connectionString: databaseUrl, ssl: true });
await client.connect();

const integrations = await client.query(
  `select id, workspace_id, provider, status, shop_domain, last_synced_at, last_sync_error, created_at, updated_at
   from integrations
   where provider = 'shopify' and shop_domain ilike '%toyiss%'`
);
console.log('=== integrations (shopify, toyiss) ===');
console.log(JSON.stringify(integrations.rows, null, 2));

if (integrations.rows.length > 0) {
  const integrationId = integrations.rows[0].id;
  const workspaceId = integrations.rows[0].workspace_id;

  const counts = await client.query(
    `select
      (select count(*) from commerce_customers where workspace_id = $1) as customers,
      (select count(*) from commerce_products where workspace_id = $1) as products,
      (select count(*) from commerce_orders where workspace_id = $1) as orders,
      (select count(*) from commerce_order_line_items li join commerce_orders o on o.id = li.order_id where o.workspace_id = $1) as order_line_items,
      (select count(*) from commerce_refunds where workspace_id = $1) as refunds,
      (select count(*) from commerce_collections where workspace_id = $1) as collections
    `,
    [workspaceId]
  );
  console.log('=== commerce entity counts for workspace ===');
  console.log(JSON.stringify(counts.rows[0], null, 2));

  const importRuns = await client.query(
    `select id, status, started_at, completed_at, error, created_at
     from import_runs where integration_id = $1 order by created_at desc limit 5`,
    [integrationId]
  );
  console.log('=== recent import_runs ===');
  console.log(JSON.stringify(importRuns.rows, null, 2));

  const reconRuns = await client.query(
    `select id, status, started_at, completed_at, error, created_at
     from reconciliation_runs where integration_id = $1 order by created_at desc limit 5`,
    [integrationId]
  );
  console.log('=== recent reconciliation_runs ===');
  console.log(JSON.stringify(reconRuns.rows, null, 2));
}

await client.end();
