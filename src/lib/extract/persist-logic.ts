import { conservativeValue, type ExtractionResult } from "./types";
import type { ExtractStatus } from "./run";

/**
 * 落库层的纯决策逻辑。
 *
 * ## 为什么把这些函数从 persist.ts 里拆出来
 *
 * persist.ts 是 IO 层：它 import `@/db`，一 import 就要有 DATABASE_URL。
 * 想测「已确认字段该从待复核清单里移除」这种规则，不该先起一个 Postgres。
 *
 * 而且用 mock 去模拟 drizzle 的链式 query builder，测的是 mock 长得像不像 drizzle，
 * 不是测业务规则 —— **那种测试红了不代表代码坏了，绿了也不代表代码对了。**
 *
 * 所以这里只放不碰 IO 的判断：字段合并、部分更新语义、审计 diff、失败归因。
 * persist.ts 负责调它们并落库。
 */

/**
 * 合并已确认字段清单。
 *
 * 复核是增量的：第一次确认了收入和社保，第二次确认公积金 ——
 * 第二次不该把前两个冲掉。所以是并集 + 去重，不是覆盖。
 */
export function mergeVerified(before: string[] | null, incoming: string[]): string[] {
  return [...new Set([...(before ?? []), ...incoming])];
}

/**
 * 计算复核后的待复核清单。
 *
 * 已确认的字段必须从待复核里移除。
 * 不移除的话，UI 上那条橙色警告会永久挂着 ——
 * **几次之后人就会无视它，警告也就失去意义。**
 * 一个永远亮着的警告灯等于没有警告灯。
 */
export function nextReviewFields(
  beforeReview: string[] | null,
  verified: string[]
): string[] {
  return (beforeReview ?? []).filter((f) => !verified.includes(f));
}

/** qualifications 表上可由复核修改的字段。leads 上的字段不在此列 */
export const QUAL_PATCHABLE = [
  "monthlyIncome",
  "incomeBasis",
  "socialSecurityMonths",
  "providentFundMonths",
  "creditInquiries3m",
  "debtMonthly",
  "businessMonths",
  "creditOverdue",
  "hasMortgage",
  "hasCarLoan",
  "hasProvidentFund",
  "age",
  "companyType",
] as const;

/**
 * 复核入参 → 数据库 patch。
 *
 * ## 关键语义：「键不存在」和「键存在但值是 null」必须区分
 *
 * 不传 `monthlyIncome` = 这次不动这个字段（保持原值）
 * 传 `monthlyIncome: null` = 人工判定「客户没说过」，要把原值清掉
 *
 * 如果用 `patch.monthlyIncome ?? before.monthlyIncome` 这种写法，
 * 上面两种情况会变成同一个结果 —— **人工没法把模型编出来的值清空**，
 * 而清空恰恰是复核最重要的动作之一（模型幻觉的修法就是清空）。
 *
 * 所以这里用 `in` 判断键是否存在，不看值真假。
 */
export function buildQualPatch(
  patch: Partial<ExtractionResult>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of QUAL_PATCHABLE) {
    if (k in patch) {
      out[k] = patch[k] ?? null;
    }
  }
  return out;
}

/**
 * 算出要同步回 leads 表的字段。
 *
 * `amountIntent` 与 `city` 不在 qualifications 上 —— 它们是线索属性，
 * 不是资质属性。但抽取会产出它们，规则引擎也从 leads 读。
 * 不同步的话，客户明明说了「想借三十万」，界面仍显示意向金额缺失。
 *
 * ## 为什么只有「已确认」的才同步
 *
 * leads.amountIntent 是裸 integer，存不下区间和「这是估的」这个信息。
 * 把模型猜的 250000 写进去，之后就没人分得清它是客户说的还是模型估的。
 * **确认过才写，是因为写进去之后信息会丢失，丢失前必须先有人负责。**
 *
 * ## 为什么取 min 而不是取 value
 *
 * conservativeValue 对模糊值返回下界。客户说「二三十万」→ 存 200000。
 * 宁可按小的报，不可按大的报 —— 报大了推过去被拒，客户白跑一趟。
 */
export function pickLeadSync(
  verifiedFields: string[],
  patch: Partial<ExtractionResult>
): { amountIntent?: number; city?: string } {
  const out: { amountIntent?: number; city?: string } = {};

  if (verifiedFields.includes("amountIntent") && patch.amountIntent !== undefined) {
    const v = conservativeValue(patch.amountIntent ?? null);
    if (v !== null) out.amountIntent = Math.round(v);
  }

  if (
    verifiedFields.includes("city") &&
    typeof patch.city === "string" &&
    patch.city.trim()
  ) {
    out.city = patch.city.trim();
  }

  return out;
}

/**
 * 审计用的变更 diff。
 *
 * 只记真正变化的字段。全字段快照会把审计日志冲成噪音 ——
 * 一条复核记录里 13 个字段有 11 个没动，真正的那 2 处修改就被埋掉了。
 *
 * 用 JSON.stringify 比较是因为数值字段是 ApproxNumber 对象，
 * 需要深比较；这些对象只有基础类型字段，序列化比较是安全的。
 */
export function changedFields(
  before: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(patch)) {
    const bv = before[k] ?? null;
    const av = patch[k] ?? null;
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      out[k] = { from: bv, to: av };
    }
  }
  return out;
}

/**
 * 抽取失败的用户可读文案。
 *
 * 四种状态分开，因为**处置动作不同**：
 *   api_error / timeout → 可重试，UI 该给「再试一次」
 *   parse_error / schema_invalid → 重试无用，是 prompt 或 schema 的问题
 *
 * 合并成一句「抽取失败」等于让人对着一个不能重试的错误反复点重试。
 */
export function extractFailureMessage(status: ExtractStatus): string {
  switch (status) {
    case "api_error":
      return "模型接口调用失败，可重试";
    case "timeout":
      return "模型响应超时，可重试";
    case "parse_error":
      return "模型返回的不是合法 JSON";
    case "schema_invalid":
      return "模型返回结构不符合约定";
    default:
      return "抽取未成功";
  }
}

/** 失败是否值得重试。UI 据此决定要不要显示重试按钮 */
export function isRetryable(status: ExtractStatus): boolean {
  return status === "api_error" || status === "timeout";
}

/**
 * 命中去重时，上次的结果能不能直接复用。
 *
 * ## 去重针对的是「重复花钱」，不是「重复尝试」
 *
 * 上次抽取失败过（api_error / timeout），这次该真跑一次 ——
 * 失败没产生有效结果，也就没有可复用的东西，拦住重试等于让这段对话永远抽不出来。
 *
 * degraded 算成功：它表示交叉校验降级了部分字段，但数据是完整的，
 * 已经落了 qualifications，复用它是对的。
 */
export function canReuse(
  prevStatus: string | null | undefined,
  hasQualification: boolean
): boolean {
  if (!hasQualification) return false;
  return prevStatus === "ok" || prevStatus === "degraded";
}
