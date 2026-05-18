import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_DEV_SERVER_PORT || 5173),
      proxy: {
        "/api": {
          target: env.VITE_BACKEND_PROXY_TARGET || "http://localhost:8081",
          changeOrigin: true,
          xfwd: true,
        },
        "/embed": {
          target: env.VITE_BACKEND_PROXY_TARGET || "http://localhost:8081",
          changeOrigin: true,
          xfwd: true,
        },
        "/public": {
          target: env.VITE_BACKEND_PROXY_TARGET || "http://localhost:8081",
          changeOrigin: true,
          xfwd: true,
        },
        "/streamfree-guard.js": {
          target: env.VITE_BACKEND_PROXY_TARGET || "http://localhost:8081",
          changeOrigin: true,
          xfwd: true,
        },
        "/cdn-cgi": {
          target: env.VITE_BACKEND_PROXY_TARGET || "http://localhost:8081",
          changeOrigin: true,
          xfwd: true,
        },
      },
    },
  };
});
