import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, leads } from "@/db/schema";
import { normalizePhone, preparePhone } from "@/lib/crypto";
import { parseAmountText } from "@/lib/ingest/schema";

/**
 * 手工建线索 —— 微信直聊客户的入口。
 *
 * ## 为什么必须有这条路径
 *
 * 在这个文件出现之前，线索只能从门户站表单进来（/api/ingest/leads）。
 * 但实际获客靠私域：朋友圈、微信直接问。**这些人根本不会去官网填表。**
 * 也就是说系统只接得住最少的那条流量，接不住最主要的那条。
 *
 * 这不是补一个便捷入口，是补一条主干道。
 *
 * ## 为什么姓名手机号必须手填，不从对话里抽
 *
 * 抽取管线不产出 name / phone，这是刻意的：
 * **手机号是线索的身份**（phone_hash 唯一索引），错一位就是另一个人。
 * 让模型从「我手机138 1234 8000」里认号码，一次幻觉就制造一条脏数据，
 * 而且它会伪装成正常线索一直存在。
 *
 * 资质字段抽错了有复核关卡兜着，身份字段抽错了没有 —— 所以不让它抽。
 */

export const createLeadSchema = z.object({
  name: z.string().trim().min(1, "请填写称呼").max(20, "称呼过长"),
  /**
   * 先归一化再校验：客户发来的号码常带空格或分隔符（138 1234 8000）。
   * 归一化能力 crypto.ts 里已有，接到这里避免"格式对的号码被判非法"。
   */
  phone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine((p) => /^1[3-9]\d{9}$/.test(p), "请填写正确的 11 位手机号"),
  /**
   * 默认 wechat 而不是 manual。
   * 这个入口九成用于微信直聊客户，默认值该对准主用途 ——
   * 来源归因错了，内容策略就是瞎写。
   */
  source: z
    .enum(["wechat", "xhs", "douyin", "referral", "manual", "website"])
    .default("wechat"),
  /** 具体从哪来：某篇朋友圈、某个中介转介绍、某条视频 */
  channelDetail: z.string().trim().max(200).optional().default(""),
  productIntent: z
    .enum(["credit", "mortgage", "car", "business", "unknown"])
    .default("unknown"),
  /** 自由文本金额，解析失败不影响建线索，原文保留 */
  amountText: z.string().trim().max(40).optional().default(""),
  city: z.string().trim().max(20).optional().default("北京"),
  note: z.string().trim().max(1000).optional().default(""),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export type CreateLeadResult = {
  leadId: number;
  /**
   * 命中已有手机号。
   * 不报错、不建重复线索 —— 客户隔一周又来问是常事，
   * 报错会让人以为操作失败而重复尝试，反而制造噪音。
   */
  duplicate: boolean;
};

export async function createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
  const { phoneEnc, phoneHash, phoneMask } = preparePhone(input.phone);
  const amountIntent = input.amountText ? parseAmountText(input.amountText) : null;

  /**
   * 金额原文一律保留。
   * parseAmountText 解析失败返回 null，但「客户说了三十万」这个信息不能丢 ——
   * 结构化字段可以为空，原始记录不能缺。与 ingest 侧口径一致。
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

  const existing = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.phoneHash, phoneHash))
    .limit(1);

  if (existing.length > 0) {
    await db.insert(auditLog).values({
      actor: "admin",
      action: "duplicate_manual_entry",
      entity: "leads",
      entityId: existing[0].id,
      /** 审计只记掩码，不记明文 —— 日志本身不该成为泄露源 */
      after: { phoneMask, source: input.source, attemptedName: input.name },
    });
    return { leadId: existing[0].id, duplicate: true };
  }

  try {
    const [row] = await db
      .insert(leads)
      .values({
        name: input.name,
        phoneEnc,
        phoneMask,
        phoneHash,
        source: input.source,
        channelDetail: input.channelDetail || null,
        productIntent: input.productIntent,
        amountIntent,
        city: input.city,
        rawNote,
        status: "new",
      })
      .returning({ id: leads.id });

    await db.insert(auditLog).values({
      actor: "admin",
      action: "create",
      entity: "leads",
      entityId: row.id,
      after: {
        phoneMask,
        source: input.source,
        channelDetail: input.channelDetail || null,
        productIntent: input.productIntent,
        amountIntent,
      },
    });

    return { leadId: row.id, duplicate: false };
  } catch (e) {
    /**
     * 竞态兜底：两个请求同时通过存在性检查时，唯一索引拦住第二个。
     * 沿用 ingest 侧的处理 —— 把竞态当成重复提交，返回已存在的那条。
     */
    const msg = String(e);
    if (msg.includes("leads_phone_hash_uniq")) {
      const again = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.phoneHash, phoneHash))
        .limit(1);
      if (again.length > 0) return { leadId: again[0].id, duplicate: true };
    }
    throw e;
  }
}
