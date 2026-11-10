import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // Comparten la base de pruebas: se ejecutan en serie
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
