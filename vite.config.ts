import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    dedupe: ['react', 'react-dom', '@tiptap/core', '@tiptap/pm'],
    alias: {
      '@cherrystudio/ui/lib/utils': resolve('src/vendor/cherry-chat/shared/lib/utils.ts'),
      '@cherrystudio/ui': resolve('src/vendor/cherry-chat/shared/ui.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
})
