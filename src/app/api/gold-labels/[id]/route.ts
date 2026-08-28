import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { goldLabels } from "@/db/schema";
import { goldLabelInputSchema } from "@/lib/gold/fields";

/** 见 ../route.ts 的盲标与认证说明 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return NextResponse.json(
      { error: { code: "bad_id", message: "id 不合法" } },
      { status: 400 }
    );
  }

  const [row] = await db
    .select()
    .from(goldLabels)
    .where(eq(goldLabels.id, numId))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { error: { code: "not_found", message: "标注不存在" } },
      { status: 404 }
    );
  }

  return NextResponse.json({ item: row });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return NextResponse.json(
      { error: { code: "bad_id", message: "id 不合法" } },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_json", message: "请求体不是合法 JSON" } },
      { status: 400 }
    );
  }

  const parsed = goldLabelInputSchema.partial().safeParse(body);
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

  const [row] = await db
    .update(goldLabels)
    .set(parsed.data)
    .where(eq(goldLabels.id, numId))
    .returning({ id: goldLabels.id });

  if (!row) {
    return NextResponse.json(
      { error: { code: "not_found", message: "标注不存在" } },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
