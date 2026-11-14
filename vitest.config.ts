import { defineConfig } from 'vitest/config';

// Tests run in Node against a fresh in-memory SQLite database built from the real migrations (see test/env.ts).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node', pool: 'forks' },
});