import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    plugins: [
      // Externalize all deps EXCEPT pure-ESM ones that must be inlined for CJS main.
      // electron-store@10 is ESM-only and cannot be `require`'d from a CJS bundle.
      externalizeDepsPlugin({ exclude: ['electron-store'] })
    ],
    build: {
      rollupOptions: {
        // Ensure esm deps we inline are resolved correctly.
        output: { format: 'cjs' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // UI version text reads __APP_VERSION__; never hand-type a version.
    define: {
      __APP_VERSION__: JSON.stringify(version)
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // Allow Vite dev server to serve files from the repo-level assets/ dir
    // (outside the renderer root). Without this, `?url` imports of
    // ../../../../assets/*.png resolve at build time but 403 in dev mode,
    // causing Phaser to fall back to its green __DEFAULT texture.
    server: {
      fs: {
        allow: [resolve('.')]
      }
    },
    plugins: [react()]
  }
})
