import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { goldLabels } from "@/db/schema";

/**
 * 标注集的读取查询。
 *
 * 抽出来单独放，是因为 API 路由和标注页（服务端组件）都要用。
 * 服务端组件直接调这里，不经过 HTTP —— 少一跳，也省掉客户端 effect。
 *
 * ⚠️ 盲标纪律（标注规范 6.1）：这里的查询**不 join 任何模型输出**
 * （extraction_runs / qualifications）。标注人若先看到模型答案会被锚定，
 * 标出来的就是模型的答案，拿它考模型等于让模型自己判卷。
 * 这条靠"没有数据通路"保证，不靠自觉。
 */

export type GoldStats = {
  total: number;
  real: number;
  synthetic: number;
  pending: number;
  corrections: number;
};

export async function getGoldStats(setName: string): Promise<GoldStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      real: sql<number>`count(*) filter (where ${goldLabels.origin} = 'real')::int`,
      synthetic: sql<number>`count(*) filter (where ${goldLabels.origin} = 'synthetic')::int`,
      pending: sql<number>`count(*) filter (where ${goldLabels.pendingReview})::int`,
      corrections: sql<number>`count(*) filter (where ${goldLabels.hasCorrection})::int`,
    })
    .from(goldLabels)
    .where(eq(goldLabels.setName, setName));

  return row ?? { total: 0, real: 0, synthetic: 0, pending: 0, corrections: 0 };
}

export async function listGoldLabels(setName: string, limit = 500) {
  return db
    .select({
      id: goldLabels.id,
      setName: goldLabels.setName,
      rawText: goldLabels.rawText,
      expected: goldLabels.expected,
      origin: goldLabels.origin,
      note: goldLabels.note,
      hasCorrection: goldLabels.hasCorrection,
      pendingReview: goldLabels.pendingReview,
      createdAt: goldLabels.createdAt,
    })
    .from(goldLabels)
    .where(eq(goldLabels.setName, setName))
    .orderBy(desc(goldLabels.id))
    .limit(limit);
}
