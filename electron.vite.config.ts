import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('electron/main/index.ts'), 'data/entry': resolve('electron/data/entry.ts'), 'agent/entry': resolve('electron/agent/entry.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  preload: { build: { rollupOptions: { input: resolve('electron/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { root: '.', base: './', plugins: [react()], build: { outDir: 'out/renderer', rollupOptions: { input: resolve('index.html') } } },
})
