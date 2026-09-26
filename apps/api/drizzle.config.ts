// drizzle-kit：按表定义生成迁移的 SQL（只在开发时使用）。生成后人工审阅再入库；合并到 main 的迁移不再修改（ADR-005）。
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  // 每个模块一个目录（P2 设计 §3.1）
  schema: './src/db/schema/*/index.ts',
  out: './src/db/migrations',
  strict: true,
  verbose: true,
})
