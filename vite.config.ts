import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The game is the city on the alignment engine. The tile city it grew out
  // of is kept as a second page rather than deleted: it is a different game
  // -- a grid, one view, no terrain -- and it still works.
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        classic: 'classic.html',
      },
    },
  },
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
