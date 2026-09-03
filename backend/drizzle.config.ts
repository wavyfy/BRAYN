import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config for the migration pipeline. schema/ holds shared
 * column conventions today; domain tables land here as each domain is
 * actually implemented (see "22. BRAYN Database Schema").
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/*.ts',
  out: './src/database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
