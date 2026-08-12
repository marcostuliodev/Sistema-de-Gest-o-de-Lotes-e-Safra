import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Agrolote — Gestão de Lotes e Safra",
        short_name: "Agrolote",
        description: "Planejamento de safra, gastos com insumos e previsão de colheita — funciona offline.",
        theme_color: "#15803d",
        background_color: "#f7f7f5",
        display: "standalone",
        start_url: "/",
        lang: "pt-BR",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\/(?!auth)/,
            handler: "NetworkFirst",
            options: { cacheName: "api-cache", expiration: { maxEntries: 200, maxAgeSeconds: 60 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});