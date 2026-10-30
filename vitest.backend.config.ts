import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['tests/backend/**/*.test.ts'], passWithNoTests: true, maxWorkers: 2 } })
