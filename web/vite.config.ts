import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the Record Server is proxied rather than called cross-origin.
 *
 * The server ships no CORS middleware, and adding one purely so a local dev
 * server can reach it would widen the production surface for a development
 * convenience. Proxying keeps the browser on a single origin, so the app talks
 * to `/api/...` and `/reviews/...` exactly as it will in production behind one
 * host. `VITE_API_BASE_URL` overrides this when the two are genuinely split.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env['RECORD_SERVER_URL'] ?? 'http://localhost:3000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/reviews': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
