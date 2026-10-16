import { defineConfig } from 'vitest/config';

// Only our own tests. work/ holds clones of other people's repos, including directories
// agents write to; their test files must never be collected and run on the host.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['work/**', 'data/**', 'node_modules/**'] },
});
