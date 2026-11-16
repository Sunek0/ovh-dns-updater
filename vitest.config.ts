import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The process bootstrap (signals/listen/exit) and type-only files are
      // exercised manually; all runtime logic is covered by unit tests.
      exclude: ['src/index.ts', 'src/ovh.d.ts', 'src/types.ts'],
      reporter: ['text', 'json-summary', 'json', 'clover'],
      thresholds: {
        statements: 92,
        branches: 82,
        functions: 95,
        lines: 93,
      },
    },
  },
});
