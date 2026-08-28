import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads, auditLog } from "@/db/schema";
import { decryptField } from "@/lib/crypto";

/**
 * POST /api/leads/[id]/phone — 解密并返回单条明文手机号。
 *
 * 三个刻意的设计：
 *
 * ① **用 POST 不用 GET。** GET 会被浏览器预取、被中间层缓存、
 *    进访问日志的 URL 里。明文手机号不该出现在这些地方。
 *
 * ② **一次只解一条。** 列表接口永不返回 phone_enc（见 lib/leads/queries.ts）。
 *    批量泄露 500 个号码和泄露 1 个，风险差两个量级。
 *
 * ③ **每次解密都留审计。** 这是个人信息访问记录。
 *    个人信息保护法要求可追溯，且真出事时这份日志是自证清白的依据。
 *    审计里只记掩码，不记明文 —— 否则日志本身就成了泄露源。
 */

export const runtime = "nodejs"; // 需要 node:crypto

export async function POST(
  _req: Request,
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

  const [row] = await db
    .select({
      id: leads.id,
      phoneEnc: leads.phoneEnc,
      phoneMask: leads.phoneMask,
    })
    .from(leads)
    .where(eq(leads.id, numId))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { error: { code: "not_found", message: "线索不存在" } },
      { status: 404 }
    );
  }

  let phone: string;
  try {
    phone = decryptField(row.phoneEnc);
  } catch (e) {
    // 解密失败通常意味着 FIELD_ENCRYPTION_KEY 换过了，属于运维事故
    console.error(`[phone] 解密失败 leadId=${numId}:`, String(e).slice(0, 200));
    return NextResponse.json(
      { error: { code: "decrypt_failed", message: "解密失败，检查加密密钥是否变更" } },
      { status: 500 }
    );
  }

  await db.insert(auditLog).values({
    actor: "admin",
    action: "reveal_phone",
    entity: "leads",
    entityId: numId,
    after: { phoneMask: row.phoneMask },
  });

  return NextResponse.json(
    { ok: true, phone },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    }
  );
}
