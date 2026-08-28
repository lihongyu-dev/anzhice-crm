import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * 数据库连接。
 *
 * Next.js 会自动加载 .env.local；但用 tsx 跑独立脚本时不会，
 * 所以这里做一次兜底加载，避免脚本里到处重复写读取逻辑。
 *
 * 本文件仅服务端使用（API 路由 / 服务端组件 / 脚本），
 * 不会被引入客户端包，所以 node:fs 静态导入是安全的。
 */
function loadEnvFallback() {
  if (process.env.DATABASE_URL) return;
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* 文件不存在时忽略，交给下面的显式报错 */
  }
}

loadEnvFallback();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL 未配置，请检查 .env.local");
}

/**
 * 连接池上限设为 5。
 * 这台机器 2 核 4G，还跑着门户站的 Next 进程和 Postgres 本身，
 * 连接数开大只会互相抢内存，没有收益。
 */
const client = postgres(process.env.DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });
export { client as pgClient };
