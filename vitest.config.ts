import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { 'src/policy/**': { lines: 90, functions: 90, branches: 90, statements: 90 } }
    }
  }
})
