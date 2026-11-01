import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 5184 } : undefined,
    watch: {
      // 排除 Rust 编译产物目录，否则 Vite watcher 与 cargo 争抢文件句柄，
      // Windows 上会报 EBUSY: resource busy or locked 导致 dev server 崩溃
      ignored: ["**/src-tauri/target/**", "**/node_modules/**", "**/*.exe"],
    },
  },
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
  },
});
