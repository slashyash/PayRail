// Vite config for the PayRail UI (Task 4).
// The dev server (and `vite preview`) proxy /api to the Express backend, so the
// browser talks to one origin and the backend needs no CORS configuration.
// fs.allow: the frontend itself plus ../samples/settlements only, so the
// Settlements page can bundle the sample CSVs (import.meta.glob) in dev mode.
import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backend = process.env.PAYRAIL_API_URL || 'http://127.0.0.1:4000';
const proxy = { '/api': { target: backend, changeOrigin: false } };
const here = fileURLToPath(new URL('.', import.meta.url));
const samples = fileURLToPath(new URL('../samples/settlements', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy, fs: { allow: [searchForWorkspaceRoot(here), samples] } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
});
