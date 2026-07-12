/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5199 },
  build: { target: 'es2022' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
