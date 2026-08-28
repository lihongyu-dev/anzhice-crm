import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads, auditLog } from "@/db/schema";
import { LEAD_STATUSES } from "@/lib/leads/status";

/**
 * PATCH /api/leads/[id] — 更新线索状态与跟进信息。
 *
 * 认证由 middleware 统一保证（本路径不在 PUBLIC_PATHS 内）。
 *
 * ⚠️ 不接受 name / phone 的修改。
 * 手机号是这条线索的身份（phone_hash 唯一索引），改它等于换人 ——
 * 应该新建线索，而不是改旧的。堵住这个口子避免审计链断裂。
 */

const patchSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  /** null 表示清除 */
  nextActionAt: z.string().datetime({ offset: true }).nullable().optional(),
  nurtureUntil: z.string().datetime({ offset: true }).nullable().optional(),
  lostReason: z.string().trim().max(200).nullable().optional(),
  /** 追加备注，不覆盖原有内容 */
  noteAppend: z.string().trim().max(1000).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId < 1) {
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
      },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const [before] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, numId))
    .limit(1);

  if (!before) {
    return NextResponse.json(
      { error: { code: "not_found", message: "线索不存在" } },
      { status: 404 }
    );
  }

  /**
   * 业务规则：转为「养客中」必须给出重捞时间。
   *
   * 这条不是形式校验。没有 nurtureUntil 的 nurture 等于把线索扔进黑洞 ——
   * 它不会出现在待办里，也没人会想起来。
   * 「被拒线索是资产」这个原则要靠这里强制，不能靠自觉。
   */
  const nextStatus = input.status ?? before.status;
  const nextNurtureUntil =
    input.nurtureUntil !== undefined
      ? input.nurtureUntil
        ? new Date(input.nurtureUntil)
        : null
      : before.nurtureUntil;

  if (nextStatus === "nurture" && !nextNurtureUntil) {
    return NextResponse.json(
      {
        error: {
          code: "nurture_needs_date",
          message: "转为「养客中」必须填重捞时间，否则这条线索会被遗忘",
        },
      },
      { status: 400 }
    );
  }

  const rawNote =
    input.noteAppend && input.noteAppend.length > 0
      ? [
          before.rawNote,
          `[${new Date().toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          })}] ${input.noteAppend}`,
        ]
          .filter(Boolean)
          .join("\n")
      : before.rawNote;

  const patch: Record<string, unknown> = { updatedAt: new Date(), rawNote };
  if (input.status !== undefined) patch.status = input.status;
  if (input.nurtureUntil !== undefined) patch.nurtureUntil = nextNurtureUntil;
  if (input.nextActionAt !== undefined) {
    patch.nextActionAt = input.nextActionAt ? new Date(input.nextActionAt) : null;
  }
  if (input.lostReason !== undefined) patch.lostReason = input.lostReason;

  const [after] = await db
    .update(leads)
    .set(patch)
    .where(eq(leads.id, numId))
    .returning({
      id: leads.id,
      status: leads.status,
      nurtureUntil: leads.nurtureUntil,
      nextActionAt: leads.nextActionAt,
      lostReason: leads.lostReason,
      rawNote: leads.rawNote,
      updatedAt: leads.updatedAt,
    });

  // 审计只记变化字段，且不含手机号任何形式
  await db.insert(auditLog).values({
    actor: "admin",
    action: "update",
    entity: "leads",
    entityId: numId,
    before: {
      status: before.status,
      nurtureUntil: before.nurtureUntil?.toISOString() ?? null,
      nextActionAt: before.nextActionAt?.toISOString() ?? null,
      lostReason: before.lostReason,
    },
    after: {
      status: after.status,
      nurtureUntil: after.nurtureUntil?.toISOString() ?? null,
      nextActionAt: after.nextActionAt?.toISOString() ?? null,
      lostReason: after.lostReason,
      noteAppended: Boolean(input.noteAppend),
    },
  });

  return NextResponse.json({ ok: true, lead: after });
}
