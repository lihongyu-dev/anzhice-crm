import type { ApproxNumber, ExtractionResult } from "@/lib/extract/types";
import { conservativeValue } from "@/lib/extract/types";
import {
  DEBT_INCOME_RATIO_MAX,
  PRODUCTS,
  type Product,
  type QualField,
} from "./products";

/**
 * 资质匹配规则引擎。
 *
 * 纯函数，无 IO、无网络、无 LLM。同样输入永远得到同样输出 ——
 * 这是它存在的全部理由（README 第六节）。
 *
 * 三个设计原则：
 *
 * ① **三态判定，不是二元。**
 *    pass / fail / unknown。「不知道」绝不能当成「不满足」，
 *    否则信息不全的客户会被静默筛掉 —— 而他们恰恰是最该去追问的人。
 *    unknown 的产出是一份「还缺什么」清单，那是下一通电话的脚本。
 *
 * ② **模糊值取保守下界。**
 *    「一万多」→ min=10000。用 conservativeValue()，宁可少推一单，
 *    不可推错一单。原因见 README 第一节：幻觉的代价不可恢复。
 *
 * ③ **只输出「可尝试 / 不满足公开条件」，绝不输出「通过 / 拒批」。**
 *    我们是撮合方，没有牌照，无权做审批判断。这是法律边界，不是措辞偏好。
 */

export type CheckStatus = "pass" | "fail" | "unknown";

export type CheckResult = {
  /** 参与判定的字段 */
  field: QualField | "debtIncomeRatio";
  label: string;
  status: CheckStatus;
  /** 人能读懂的判定理由。fail 时必须能回答"为什么" */
  reason: string;
};

export type MatchStatus =
  /** 全部公开条件均满足 */
  | "eligible"
  /** 有明确不满足项 */
  | "not_eligible"
  /** 无明确不满足项，但有信息缺失 */
  | "need_info";

export type ProductMatch = {
  productId: string;
  productName: string;
  category: Product["category"];
  status: MatchStatus;
  checks: CheckResult[];
  /** 明确不满足的项，直接可用于跟客户解释 */
  blockers: CheckResult[];
  /** 需要补充的字段清单 = 下一通电话要问什么 */
  missing: CheckResult[];
  referenceRate: string;
  notes?: string;
};

export type MatchReport = {
  /** 按可推荐程度排序：eligible → need_info → not_eligible */
  matches: ProductMatch[];
  /** 全部产品都缺的同一批字段，优先问这些 */
  topMissingFields: { field: string; label: string; count: number }[];
  summary: {
    eligible: number;
    needInfo: number;
    notEligible: number;
  };
  /** ⚠️ 必须随结果一起展示，不可省略 */
  disclaimer: string;
};

const DISCLAIMER =
  "以上为依据机构公开申请条件的信息匹配结果，非审批结论，不构成任何放款承诺。" +
  "实际能否办理及具体条件由持牌机构独立评估。";

/** 取数值字段的保守值 */
function numOf(q: ExtractionResult, field: QualField): number | null {
  const v = q[field];
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v; // age
  if (typeof v === "object" && "isApproximate" in v) {
    return conservativeValue(v as ApproxNumber);
  }
  return null;
}

/** 数值字段的原文，用于解释判定依据 */
function rawOf(q: ExtractionResult, field: QualField): string {
  const v = q[field];
  if (v && typeof v === "object" && "rawText" in v) {
    return (v as ApproxNumber).rawText || "";
  }
  return "";
}

function checkNumeric(
  q: ExtractionResult,
  rule: { field: QualField; min?: number; max?: number; label: string; unit: string }
): CheckResult {
  const val = numOf(q, rule.field);
  const raw = rawOf(q, rule.field);

  if (val === null) {
    return {
      field: rule.field,
      label: rule.label,
      status: "unknown",
      reason: `${rule.label}未知，需补充确认`,
    };
  }

  const suffix = raw ? `（客户表述：${raw}）` : "";

  if (rule.min !== undefined && val < rule.min) {
    return {
      field: rule.field,
      label: rule.label,
      status: "fail",
      reason: `${rule.label} ${val}${rule.unit}，低于公开条件要求的 ${rule.min}${rule.unit}${suffix}`,
    };
  }

  if (rule.max !== undefined && val > rule.max) {
    return {
      field: rule.field,
      label: rule.label,
      status: "fail",
      reason: `${rule.label} ${val}${rule.unit}，超过公开条件上限 ${rule.max}${rule.unit}${suffix}`,
    };
  }

  const bound =
    rule.min !== undefined
      ? `≥${rule.min}${rule.unit}`
      : `≤${rule.max}${rule.unit}`;
  return {
    field: rule.field,
    label: rule.label,
    status: "pass",
    reason: `${rule.label} ${val}${rule.unit}，满足 ${bound}${suffix}`,
  };
}

function checkBoolean(
  q: ExtractionResult,
  rule: { field: QualField; equals: boolean; label: string }
): CheckResult {
  const v = q[rule.field];

  /**
   * null 是 unknown，不是 false。
   * 标注规范里反复强调的区分（「有套房」不能推出「有房贷」），
   * 到了规则引擎这里必须继续保持，否则前面的努力全白费。
   */
  if (v === null || v === undefined) {
    return {
      field: rule.field,
      label: rule.label,
      status: "unknown",
      reason: `${rule.label}未知，需补充确认`,
    };
  }

  if (typeof v !== "boolean") {
    return {
      field: rule.field,
      label: rule.label,
      status: "unknown",
      reason: `${rule.label}数据异常，需人工核对`,
    };
  }

  return {
    field: rule.field,
    label: rule.label,
    status: v === rule.equals ? "pass" : "fail",
    reason:
      v === rule.equals
        ? `${rule.label}：符合`
        : `${rule.label}：不符合公开条件`,
  };
}

/**
 * 负债收入比。这一项不在单个产品的规则表里，而是全局共用 ——
 * 因为它是行业普遍红线（月还款总额 / 月收入 ≤ 70%），
 * 不是某家机构的特殊要求。
 */
function checkDebtIncomeRatio(q: ExtractionResult): CheckResult {
  const income = numOf(q, "monthlyIncome");
  const debt = numOf(q, "debtMonthly");

  if (income === null || debt === null) {
    const lack = [
      income === null ? "月收入" : null,
      debt === null ? "月还款总额" : null,
    ]
      .filter(Boolean)
      .join("、");
    return {
      field: "debtIncomeRatio",
      label: "负债收入比",
      status: "unknown",
      reason: `${lack}未知，无法计算负债收入比`,
    };
  }

  if (income <= 0) {
    return {
      field: "debtIncomeRatio",
      label: "负债收入比",
      status: "unknown",
      reason: "月收入为 0 或异常，无法计算",
    };
  }

  const ratio = debt / income;
  const pct = (ratio * 100).toFixed(0);
  const maxPct = (DEBT_INCOME_RATIO_MAX * 100).toFixed(0);

  return {
    field: "debtIncomeRatio",
    label: "负债收入比",
    status: ratio <= DEBT_INCOME_RATIO_MAX ? "pass" : "fail",
    reason:
      ratio <= DEBT_INCOME_RATIO_MAX
        ? `月还款 ${debt} / 月收入 ${income} = ${pct}%，在 ${maxPct}% 以内`
        : `月还款 ${debt} / 月收入 ${income} = ${pct}%，超过行业普遍红线 ${maxPct}%`,
  };
}

function checkAge(q: ExtractionResult, p: Product): CheckResult | null {
  if (p.ageMin === undefined && p.ageMax === undefined) return null;

  if (q.age === null || q.age === undefined) {
    return {
      field: "age",
      label: "年龄",
      status: "unknown",
      reason: "年龄未知，需补充确认",
    };
  }

  if (p.ageMin !== undefined && q.age < p.ageMin) {
    return {
      field: "age",
      label: "年龄",
      status: "fail",
      reason: `年龄 ${q.age} 岁，低于公开条件下限 ${p.ageMin} 岁`,
    };
  }
  if (p.ageMax !== undefined && q.age > p.ageMax) {
    return {
      field: "age",
      label: "年龄",
      status: "fail",
      reason: `年龄 ${q.age} 岁，超过公开条件上限 ${p.ageMax} 岁`,
    };
  }
  return {
    field: "age",
    label: "年龄",
    status: "pass",
    reason: `年龄 ${q.age} 岁，在 ${p.ageMin ?? "-"}~${p.ageMax ?? "-"} 岁范围内`,
  };
}

function checkCompanyType(q: ExtractionResult, p: Product): CheckResult | null {
  if (!p.companyTypes || p.companyTypes.length === 0) return null;

  if (!q.companyType) {
    return {
      field: "companyType",
      label: "单位性质",
      status: "unknown",
      reason: "单位性质未知，需补充确认",
    };
  }

  const ok = p.companyTypes.includes(q.companyType);
  return {
    field: "companyType",
    label: "单位性质",
    status: ok ? "pass" : "fail",
    reason: ok
      ? "单位性质符合该产品适用范围"
      : "单位性质不在该产品适用范围内",
  };
}

export function matchProduct(q: ExtractionResult, p: Product): ProductMatch {
  const checks: CheckResult[] = [];

  for (const r of p.numeric) checks.push(checkNumeric(q, r));
  for (const r of p.boolean) checks.push(checkBoolean(q, r));

  const age = checkAge(q, p);
  if (age) checks.push(age);

  const company = checkCompanyType(q, p);
  if (company) checks.push(company);

  // 负债收入比只对需要收入的产品有意义
  if (p.numeric.some((r) => r.field === "monthlyIncome")) {
    checks.push(checkDebtIncomeRatio(q));
  }

  const blockers = checks.filter((c) => c.status === "fail");
  const missing = checks.filter((c) => c.status === "unknown");

  /**
   * 判定优先级：有 fail 就是 not_eligible，
   * 否则有 unknown 就是 need_info，全 pass 才 eligible。
   *
   * 注意顺序：fail 优先于 unknown。
   * 已知不满足的情况下，再去补其他信息是浪费客户和自己的时间。
   */
  const status: MatchStatus =
    blockers.length > 0
      ? "not_eligible"
      : missing.length > 0
        ? "need_info"
        : "eligible";

  return {
    productId: p.id,
    productName: p.name,
    category: p.category,
    status,
    checks,
    blockers,
    missing,
    referenceRate: p.referenceRate,
    notes: p.notes,
  };
}

const STATUS_ORDER: Record<MatchStatus, number> = {
  eligible: 0,
  need_info: 1,
  not_eligible: 2,
};

export function matchAll(
  q: ExtractionResult,
  opts: { category?: Product["category"] } = {}
): MatchReport {
  const pool = opts.category
    ? PRODUCTS.filter((p) => p.category === opts.category)
    : PRODUCTS;

  const matches = pool
    .map((p) => matchProduct(q, p))
    .sort((a, b) => {
      const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (d !== 0) return d;
      // 同状态下缺得少的排前面：补齐成本低
      return a.missing.length - b.missing.length;
    });

  /**
   * 汇总所有产品共同缺失的字段并按出现次数排序。
   * 这份清单的用途很具体：**下一通电话先问哪一项**。
   * 问一个能同时解锁多款产品的字段，比逐个产品去补效率高得多。
   */
  const counter = new Map<string, { field: string; label: string; count: number }>();
  for (const m of matches) {
    for (const c of m.missing) {
      const key = String(c.field);
      const cur = counter.get(key);
      if (cur) cur.count += 1;
      else counter.set(key, { field: key, label: c.label, count: 1 });
    }
  }
  const topMissingFields = [...counter.values()].sort((a, b) => b.count - a.count);

  return {
    matches,
    topMissingFields,
    summary: {
      eligible: matches.filter((m) => m.status === "eligible").length,
      needInfo: matches.filter((m) => m.status === "need_info").length,
      notEligible: matches.filter((m) => m.status === "not_eligible").length,
    },
    disclaimer: DISCLAIMER,
  };
}
