import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { goldLabels } from "@/db/schema";
import { goldLabelInputSchema } from "@/lib/gold/fields";

/**
 * 标注集接口。
 *
 * ⚠️ 盲标纪律在这一层强制（标注规范 6.1）：
 * 本接口**永不返回任何模型输出**（extraction_runs / qualifications 一律不 join）。
 * 原因：标注人若先看到模型答案会被锚定 —— 模型填 40，人看着觉得「差不多」就认了，
 * 标出来的是模型的答案，拿它考模型等于让模型自己判自己的卷子。
 * 这条不是靠自觉，是靠接口层没有那条数据通路。
 *
 * ⚠️ 当前无认证。P1 阶段的 middleware 完成前，此接口不可暴露到公网。
 * 部署前必须确认 nginx 未反代到本服务，或已加 IP 白名单。
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const setName = url.searchParams.get("set") ?? "gold_v1";

  const items = await db
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
    .limit(500);

  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      real: sql<number>`count(*) filter (where ${goldLabels.origin} = 'real')::int`,
      synthetic: sql<number>`count(*) filter (where ${goldLabels.origin} = 'synthetic')::int`,
      pending: sql<number>`count(*) filter (where ${goldLabels.pendingReview})::int`,
      corrections: sql<number>`count(*) filter (where ${goldLabels.hasCorrection})::int`,
    })
    .from(goldLabels)
    .where(eq(goldLabels.setName, setName));

  return NextResponse.json({ items, stats });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_json", message: "请求体不是合法 JSON" } },
      { status: 400 }
    );
  }

  const parsed = goldLabelInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "validation_failed",
          message: "标注数据校验失败",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      },
      { status: 400 }
    );
  }

  const d = parsed.data;
  const [row] = await db
    .insert(goldLabels)
    .values({
      setName: d.setName,
      rawText: d.rawText,
      expected: d.expected,
      origin: d.origin,
      note: d.note,
      hasCorrection: d.hasCorrection,
      pendingReview: d.pendingReview,
    })
    .returning({ id: goldLabels.id });

  return NextResponse.json({ id: row.id }, { status: 201 });
}
