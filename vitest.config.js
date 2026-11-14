import { defineConfig } from "vitest/config";

// รันเทสทั้ง client (app/test) และ worker (worker/test) ด้วยคำสั่งเดียว: npm test
export default defineConfig({
  test: {
    include: ["app/test/**/*.test.js", "worker/test/**/*.test.ts"],
    environment: "node",
  },
});
