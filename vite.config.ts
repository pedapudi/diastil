import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5199 },
  build: { target: 'es2022' },
})
