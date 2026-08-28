import { z } from "zod";

/**
 * 门户站投递线索的入参。
 *
 * 刻意**不复用**门户站的 leadSchema：那是表单校验（含蜜罐、consent 等
 * 只有浏览器场景才有的字段）。这里是服务间契约，两者生命周期不同 ——
 * 门户站改表单不该迫使 CRM 跟着改，反之亦然。
 *
 * 字段映射（门户站 → CRM）：
 *   product → productIntent
 *   amount（自由文本，如"三十万"）→ amountIntent（整数元）+ rawNote 保留原文
 *   note → rawNote
 */

export const ingestLeadSchema = z.object({
  name: z.string().trim().min(1, "缺少称呼").max(20),
  phone: z
    .string()
    .trim()
    .regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
  productIntent: z
    .enum(["credit", "mortgage", "car", "business", "unknown"])
    .default("unknown"),
  /** 门户站表单里金额是自由文本，转换在 CRM 侧做，失败不影响入库 */
  amountText: z.string().trim().max(40).optional().default(""),
  city: z.string().trim().max(20).optional().default("北京"),
  note: z.string().trim().max(500).optional().default(""),

  /** 来源归因。内容策略要靠这些字段修正，缺了就是瞎写 */
  source: z
    .enum(["website", "xhs", "wechat", "douyin", "referral", "manual"])
    .default("website"),
  channelDetail: z.string().trim().max(200).optional().nullable().default(null),
  landingPage: z.string().trim().max(500).optional().nullable().default(null),
  utm: z.record(z.string(), z.string()).optional().nullable().default(null),

  /** 门户站提交时间。跨服务调用可能延迟或重放，用它保留真实发生时刻 */
  submittedAt: z.string().datetime({ offset: true }).optional().nullable().default(null),
});

export type IngestLeadInput = z.infer<typeof ingestLeadSchema>;

/**
 * 把"三十万""30w""20-30万"这类自由文本转成整数元。
 *
 * 转不出来就返回 null —— **绝不猜**。
 * 原文一律保留在 rawNote 里，人工看得到，不会因为解析失败丢信息。
 * 这和抽取管线的原则一致：宁可留空，不可编造。
 */
export function parseAmountText(text: string): number | null {
  const s = text.trim().replace(/\s/g, "");
  if (!s) return null;

  // 区间取下界（保守），如"20-30万"→ 200000
  const range = s.match(/^(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*(万|w|W)?/);
  if (range) {
    const lo = Number(range[1]);
    const unit = range[3] ? 10000 : 1;
    return Number.isFinite(lo) ? Math.round(lo * unit) : null;
  }

  const cn: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };

  // 「三十万」「二十万」
  const cnTens = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?(万|w|W)/);
  if (cnTens) {
    const tens = cnTens[1] ? cn[cnTens[1]] : 1;
    const ones = cnTens[2] ? cn[cnTens[2]] : 0;
    return (tens * 10 + ones) * 10000;
  }

  // 「五万」
  const cnOne = s.match(/^([一二两三四五六七八九])(万|w|W)/);
  if (cnOne) return cn[cnOne[1]] * 10000;

  // 「30万」「30w」「1.5万」
  const num = s.match(/^(\d+(?:\.\d+)?)\s*(万|w|W)/);
  if (num) return Math.round(Number(num[1]) * 10000);

  // 纯数字：≥1000 视为元，否则视为万（"30" 一般指 30 万）
  const plain = s.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) {
    const v = Number(plain[1]);
    if (!Number.isFinite(v)) return null;
    return v >= 1000 ? Math.round(v) : Math.round(v * 10000);
  }

  return null;
}
