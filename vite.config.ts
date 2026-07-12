/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  // relative asset paths so the built bundle also works mounted at /editor/
  // by the dia CLI, not only at the server root
  base: './',
  server: { port: 5199 },
  build: { target: 'es2022' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
