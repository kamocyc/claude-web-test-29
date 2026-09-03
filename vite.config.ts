import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The default is "cores - 1", but every test here is CPU-bound simulation
    // or geometry, so the core left idle is just idle. Taken from the ported
    // engine's own config, where it cut the wall clock by about a tenth.
    maxWorkers: '100%',
  },
});
