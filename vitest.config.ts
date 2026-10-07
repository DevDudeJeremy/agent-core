import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/setup.ts installs the network kill switch (global fetch throws).
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Fail fast if a test leaks a timer or open handle (e.g. an SSE keepalive).
    teardownTimeout: 2000,
  },
});
