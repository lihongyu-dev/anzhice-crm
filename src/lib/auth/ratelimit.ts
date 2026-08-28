import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { loginAttempts } from "@/db/schema";

/**
 * 登录限流。写数据库，不用内存 Map。
 *
 * 门户站 2026-08-26 那版用的是模块级 Map，而 systemd 配了 Restart=always。
 * 进程一重启计数就清零 —— 打崩进程或等一次部署就能重置额度，等于没有限流。
 * 写库多一次 IO，但重启不丢、可审计、能查历史。
 */

/** 15 分钟窗口内最多 5 次失败 */
const WINDOW_MIN = 15;
const MAX_FAILURES = 5;

export function clientIp(req: Request): string {
  // nginx 已配置 X-Forwarded-For；取首段（最接近真实客户端的那个）
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function isLocked(ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MIN * 60_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.ip, ip),
        eq(loginAttempts.success, false),
        gte(loginAttempts.at, since)
      )
    );
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordAttempt(ip: string, success: boolean) {
  await db.insert(loginAttempts).values({ ip, success });
}

/** 登录成功后清掉该 IP 的失败记录，避免累积到后面误锁 */
export async function clearFailures(ip: string) {
  await db
    .delete(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false)));
}
