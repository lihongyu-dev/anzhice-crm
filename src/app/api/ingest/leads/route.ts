import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads, auditLog } from "@/db/schema";
import { preparePhone } from "@/lib/crypto";
import { verifyIngestToken } from "@/lib/ingest/token";
import { ingestLeadSchema, parseAmountText } from "@/lib/ingest/schema";

/**
 * POST /api/ingest/leads — 门户站投递线索的唯一入口。
 *
 * 只写不读。这个接口没有 GET，故意的：
 * 门户站在公网被拿下时，攻击者拿到令牌也只能往里塞数据，
 * 拉不走任何存量客户手机号。
 *
 * 幂等：phone_hash 有唯一索引。同一手机号重复提交不报错、不建重复线索，
 * 而是补全空字段 + 记一条审计。
 * 理由：客户在网站上填两次是常见行为（第一次没等到回复），
 * 报 409 会让门户站误判成失败而重试，反而制造噪音。
 *
 * 未认证返回 404 而非 401 —— 沿用全站口径，不告诉扫描器这个端点存在。
 */

export const runtime = "nodejs"; // 需要 node:crypto 做加密，不能跑 edge

export async function POST(req: Request) {
  if (!verifyIngestToken(req)) {
    return new NextResponse(null, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = ingestLeadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "参数校验失败",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 400 }
    );
  }

  const input = parsed.data;

  // 手机号进库前立刻转成加密三件套，明文不落任何一列
  const { phoneEnc, phoneHash, phoneMask } = preparePhone(input.phone);

  const amountIntent = input.amountText ? parseAmountText(input.amountText) : null;

  /**
   * 金额原文一律保留。
   * parseAmountText 解析失败时返回 null，但"客户说了三十万"这个信息不能丢 ——
   * 结构化字段可以为空，原始记录不能缺。
   */
  const noteParts: string[] = [];
  if (input.note) noteParts.push(input.note);
  if (input.amountText) {
    noteParts.push(
      amountIntent === null
        ? `[金额原文未能解析] ${input.amountText}`
        : `[金额原文] ${input.amountText}`
    );
  }
  const rawNote = noteParts.join("\n") || null;

  const submittedAt = input.submittedAt ? new Date(input.submittedAt) : new Date();

  try {
    const existing = await db
      .select({ id: leads.id, name: leads.name, rawNote: leads.rawNote })
      .from(leads)
      .where(eq(leads.phoneHash, phoneHash))
      .limit(1);

    if (existing.length > 0) {
      const prev = existing[0];
      await db.insert(auditLog).values({
        actor: "ingest:website",
        action: "duplicate_submission",
        entity: "leads",
        entityId: prev.id,
        // 不记 phone 明文，只记掩码
        after: {
          phoneMask,
          productIntent: input.productIntent,
          amountText: input.amountText || null,
          note: input.note || null,
          submittedAt: submittedAt.toISOString(),
        },
      });

      return NextResponse.json(
        { ok: true, leadId: prev.id, duplicate: true },
        { status: 200 }
      );
    }

    const [row] = await db
      .insert(leads)
      .values({
        name: input.name,
        phoneEnc,
        phoneMask,
        phoneHash,
        source: input.source,
        channelDetail: input.channelDetail,
        landingPage: input.landingPage,
        utm: input.utm ?? undefined,
        productIntent: input.productIntent,
        amountIntent,
        city: input.city,
        rawNote,
        status: "new",
        createdAt: submittedAt,
        updatedAt: submittedAt,
      })
      .returning({ id: leads.id });

    await db.insert(auditLog).values({
      actor: "ingest:website",
      action: "create",
      entity: "leads",
      entityId: row.id,
      after: {
        phoneMask,
        source: input.source,
        productIntent: input.productIntent,
        amountIntent,
        landingPage: input.landingPage,
      },
    });

    return NextResponse.json({ ok: true, leadId: row.id, duplicate: false }, { status: 201 });
  } catch (e) {
    // 竞态兜底：两个请求同时通过存在性检查时，唯一索引会拦住第二个
    const msg = String(e);
    if (msg.includes("leads_phone_hash_uniq")) {
      const again = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.phoneHash, phoneHash))
        .limit(1);
      if (again.length > 0) {
        return NextResponse.json(
          { ok: true, leadId: again[0].id, duplicate: true },
          { status: 200 }
        );
      }
    }
    console.error("[ingest] 入库失败:", msg.slice(0, 300));
    return NextResponse.json({ error: "入库失败" }, { status: 500 });
  }
}
