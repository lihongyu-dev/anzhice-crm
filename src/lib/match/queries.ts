import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { leads, qualifications } from "@/db/schema";
import { extractionSchema, type ExtractionResult } from "@/lib/extract/types";
import { matchAll, type MatchReport } from "./engine";

/**
 * 把数据库里的资质记录喂给规则引擎。
 *
 * 规则引擎（engine.ts）是纯函数，不碰 IO —— 这一层负责取数与形状转换，
 * 让引擎保持可单测。
 *
 * ## 为什么"没有资质记录"不是错误
 *
 * `qualifications` 表可能一行都没有（新线索刚从官网表单进来，还没通过
 * 对话抽取过资质）。这时候不该报错、也不该返回空 —— 应该把
 * **全部字段当作 unknown** 喂进引擎。
 *
 * 引擎对全 unknown 输入的产出是「还缺什么」的优先级清单，
 * 也就是**第一通电话该问什么**。这恰恰是新线索最需要的东西。
 *
 * 换句话说：资质为空时这个功能不是降级，而是它最主要的用法。
 */

/** 资质数据的来源与可信度。UI 必须据此提示，不能让人误以为已核实 */
export type QualSource =
  /** 有抽取记录，且关键字段经人工确认 */
  | "verified"
  /** 有抽取记录，但字段未经人工确认（LLM 抽取原值） */
  | "extracted"
  /** 无任何资质记录，全字段按未知处理 */
  | "empty";

export type LeadMatchResult = {
  leadId: number;
  source: QualSource;
  /** 已人工确认的字段名。source=verified 时非空 */
  verifiedFields: string[];
  /** 交叉校验降级、需人工复核的字段 */
  reviewFields: string[];
  /** 资质记录的更新时间。判断数据新鲜度用 */
  qualUpdatedAt: string | null;
  report: MatchReport;
};

/**
 * 全 null 的 ExtractionResult。
 *
 * 用 schema.parse({}) 生成而不是手写字面量 —— 每个字段都有 `.default(null)`，
 * 所以空对象过一遍 schema 就是"全部未知"。
 * 好处是将来 schema 加字段，这里自动跟上，不会漏。
 */
function emptyExtraction(): ExtractionResult {
  return extractionSchema.parse({});
}

/**
 * qualifications 行 + leads 行 → ExtractionResult。
 *
 * 两张表都要读：资质字段在 qualifications，而 `amountIntent`（借款意向金额）
 * 和 `city` 在 leads 上 —— 它们是线索属性，不是资质属性。
 *
 * ⚠️ leads.amountIntent 是 integer（元），而引擎要的是 ApproxNumber。
 * 这里包装成"精确值"：客户填表单时选的金额区间是他自己填的，
 * 不是模型猜的，所以 isApproximate=false 是诚实的。
 */
function toExtraction(
  qual: typeof qualifications.$inferSelect | null,
  lead: { amountIntent: number | null; city: string | null }
): ExtractionResult {
  const base = emptyExtraction();

  if (lead.amountIntent !== null) {
    base.amountIntent = {
      value: lead.amountIntent,
      min: lead.amountIntent,
      max: lead.amountIntent,
      isApproximate: false,
      rawText: `表单填写 ${lead.amountIntent} 元`,
    };
  }
  base.city = lead.city;

  if (!qual) return base;

  base.monthlyIncome = qual.monthlyIncome ?? null;
  base.incomeBasis = (qual.incomeBasis as ExtractionResult["incomeBasis"]) ?? null;
  base.socialSecurityMonths = qual.socialSecurityMonths ?? null;
  base.providentFundMonths = qual.providentFundMonths ?? null;
  base.creditInquiries3m = qual.creditInquiries3m ?? null;
  base.debtMonthly = qual.debtMonthly ?? null;
  base.businessMonths = qual.businessMonths ?? null;

  base.creditOverdue = qual.creditOverdue ?? null;
  base.hasMortgage = qual.hasMortgage ?? null;
  base.hasCarLoan = qual.hasCarLoan ?? null;
  base.hasProvidentFund = qual.hasProvidentFund ?? null;

  base.age = qual.age ?? null;
  base.companyType = (qual.companyType as ExtractionResult["companyType"]) ?? null;

  return base;
}

/**
 * 取某条线索的匹配结果。
 *
 * ## 为什么按 productIntent 收窄产品池
 *
 * 客户在表单里选了"房抵贷"，就不该拿信用贷的条件去判他 ——
 * 五款产品全列出来会让页面变成噪音，而车上扫一眼的场景经不起噪音。
 *
 * 但 `unknown`（意向未明）时**不收窄**：那正是需要全盘看的情况。
 */
export async function getLeadMatch(leadId: number): Promise<LeadMatchResult | null> {
  const [lead] = await db
    .select({
      id: leads.id,
      productIntent: leads.productIntent,
      amountIntent: leads.amountIntent,
      city: leads.city,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead) return null;

  /**
   * 一条线索可能有多条资质记录（每次对话抽取一条）。取最新的。
   * 不做跨记录合并 —— 合并需要"哪条更可信"的判断依据，
   * 而字段级时间戳目前没有。宁可少用信息，不可拼出一份谁都没说过的资质。
   */
  const [qual] = await db
    .select()
    .from(qualifications)
    .where(eq(qualifications.leadId, leadId))
    .orderBy(desc(qualifications.updatedAt))
    .limit(1);

  const extraction = toExtraction(qual ?? null, lead);

  const category =
    lead.productIntent && lead.productIntent !== "unknown"
      ? (lead.productIntent as "credit" | "mortgage" | "car" | "business")
      : undefined;

  const report = matchAll(extraction, { category });

  const verifiedFields = qual?.verifiedFields ?? [];
  const reviewFields = qual?.reviewFields ?? [];

  const source: QualSource = !qual
    ? "empty"
    : verifiedFields.length > 0
      ? "verified"
      : "extracted";

  return {
    leadId,
    source,
    verifiedFields,
    reviewFields,
    qualUpdatedAt: qual?.updatedAt?.toISOString() ?? null,
    report,
  };
}
