import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('electron/main/index.ts'), 'data/entry': resolve('electron/data/entry.ts'), 'agent/entry': resolve('electron/agent/entry.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  preload: { build: { rollupOptions: { input: resolve('electron/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { root: '.', base: './', plugins: [react(), tailwind()],
    resolve: {
      dedupe: ['react', 'react-dom', '@tiptap/core', '@tiptap/pm'],
      alias: {
        '@cherrystudio/ui/lib/utils': resolve('src/vendor/cherry-chat/shared/lib/utils.ts'),
        '@cherrystudio/ui': resolve('src/vendor/cherry-chat/shared/ui.ts'),
      },
    },
    build: { outDir: 'out/renderer', rollupOptions: { input: resolve('index.html') } } },
})
