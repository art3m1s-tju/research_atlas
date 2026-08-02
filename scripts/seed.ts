#!/usr/bin/env tsx
/**
 * 数据库种子脚本
 *
 * 用法: npm run db:seed
 * 功能: 初始化 SQLite 数据库并写入种子数据
 */

import { seedDatabase } from "../src/lib/seed-data";

console.log("========================================");
console.log("AI Research Atlas - 数据库初始化");
console.log("========================================\n");

try {
  seedDatabase();
  console.log("\n✅ 数据库初始化完成！");
  console.log("运行 'npm run dev' 启动开发服务器。");
} catch (error) {
  console.error("\n❌ 数据库初始化失败:", error);
  process.exit(1);
}
