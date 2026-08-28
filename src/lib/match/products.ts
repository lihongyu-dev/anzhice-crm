/**
 * 产品准入规则库。
 *
 * ⚠️ 合规声明（不可删除，任何新增产品都要遵守）：
 * 本项目是**信息匹配与撮合**，非自营、无金融牌照。
 * 所以这里的规则表达的是「机构公开的申请条件」，**不是审批标准**，
 * 输出一律用「可尝试 / 不满足公开条件」，绝不出现
 * 「通过 / 拒批 / 包过 / 能放款 / 额度」等表述。
 * 最终结果由持牌机构独立评估。
 *
 * 为什么规则用代码而不用 LLM（README 第六节）：
 * 「这个客户为什么不匹配这款产品」必须能给出确定答案 ——
 * 「近3月征信查询8次，超过该产品公开条件上限6次」。
 * LLM 给不出可审计的因果链，且同样输入可能得到不同结论。
 * 金融相关判断上，可解释性优先于准确率。
 *
 * 数据来源：北京地区常见助贷产品的公开申请条件，2026-08 整理。
 * 阈值会变，所以每条带 updatedAt，过期需重新核对。
 */

import type { ExtractionResult } from "@/lib/extract/types";

/** 规则判定用到的字段名，用于生成「还缺什么」清单 */
export type QualField = keyof ExtractionResult;

export type NumericRule = {
  field: QualField;
  /** 下限（含）。如社保连续月数 ≥ 6 */
  min?: number;
  /** 上限（含）。如近3月查询次数 ≤ 6 */
  max?: number;
  label: string;
  unit: string;
};

export type BooleanRule = {
  field: QualField;
  /** 要求该布尔字段等于此值 */
  equals: boolean;
  label: string;
};

export type Product = {
  id: string;
  name: string;
  /** 产品大类，对应线索的 productIntent */
  category: "credit" | "mortgage" | "car" | "business";
  /** 面向人群，展示用 */
  audience: string;
  numeric: NumericRule[];
  boolean: BooleanRule[];
  /** 允许的单位性质。为空表示不限 */
  companyTypes?: string[];
  ageMin?: number;
  ageMax?: number;
  /** 参考区间，只能是区间且必须声明非承诺 */
  referenceRate: string;
  updatedAt: string;
  notes?: string;
};

/**
 * 阈值设定说明：
 * 征信查询次数上限普遍在 6~10 次（近3月）；
 * 社保/公积金连续月数普遍要求 6 个月起，优质产品要 12 个月;
 * 负债收入比（月还款/月收入）红线普遍在 50%~70%（见 DEBT_INCOME_RATIO_MAX）。
 */
export const DEBT_INCOME_RATIO_MAX = 0.7;

export const PRODUCTS: Product[] = [
  {
    id: "credit-salaried-a",
    name: "工薪信用贷 A 档",
    category: "credit",
    audience: "有社保公积金的在职人员",
    numeric: [
      { field: "monthlyIncome", min: 5000, label: "月收入", unit: "元" },
      { field: "socialSecurityMonths", min: 12, label: "社保连续月数", unit: "月" },
      { field: "creditInquiries3m", max: 6, label: "近3月征信查询", unit: "次" },
    ],
    boolean: [
      { field: "creditOverdue", equals: false, label: "无当前逾期" },
      { field: "hasProvidentFund", equals: true, label: "有公积金" },
    ],
    ageMin: 23,
    ageMax: 55,
    referenceRate: "年化 3.4%~8%（参考区间，非承诺，由机构核定）",
    updatedAt: "2026-08-28",
    notes: "公积金连续缴存是主要门槛",
  },
  {
    id: "credit-salaried-b",
    name: "工薪信用贷 B 档",
    category: "credit",
    audience: "社保时间较短或无公积金的在职人员",
    numeric: [
      { field: "monthlyIncome", min: 4000, label: "月收入", unit: "元" },
      { field: "socialSecurityMonths", min: 6, label: "社保连续月数", unit: "月" },
      { field: "creditInquiries3m", max: 10, label: "近3月征信查询", unit: "次" },
    ],
    boolean: [{ field: "creditOverdue", equals: false, label: "无当前逾期" }],
    ageMin: 22,
    ageMax: 58,
    referenceRate: "年化 7%~18%（参考区间，非承诺，由机构核定）",
    updatedAt: "2026-08-28",
    notes: "门槛低于 A 档，参考利率相应更高",
  },
  {
    id: "mortgage-second",
    name: "房产抵押（二次抵押）",
    category: "mortgage",
    audience: "北京有房产、已有按揭未结清",
    numeric: [
      { field: "monthlyIncome", min: 8000, label: "月收入", unit: "元" },
      { field: "creditInquiries3m", max: 10, label: "近3月征信查询", unit: "次" },
    ],
    boolean: [
      { field: "hasMortgage", equals: true, label: "名下有按揭房产" },
      { field: "creditOverdue", equals: false, label: "无当前逾期" },
    ],
    ageMin: 25,
    ageMax: 60,
    referenceRate: "年化 3.2%~6%（参考区间，非承诺，由机构核定）",
    updatedAt: "2026-08-28",
    notes: "需评估房产剩余抵押空间，以机构评估为准",
  },
  {
    id: "car-pledge",
    name: "车辆抵押",
    category: "car",
    audience: "名下有车且无未结清车贷",
    numeric: [{ field: "creditInquiries3m", max: 12, label: "近3月征信查询", unit: "次" }],
    boolean: [{ field: "hasCarLoan", equals: false, label: "无未结清车贷" }],
    ageMin: 22,
    ageMax: 60,
    referenceRate: "年化 6%~18%（参考区间，非承诺，由机构核定）",
    updatedAt: "2026-08-28",
    notes: "车辆估值以机构现场评估为准",
  },
  {
    id: "business-owner",
    name: "企业经营贷",
    category: "business",
    audience: "个体户 / 企业主，执照满一定年限",
    numeric: [
      { field: "businessMonths", min: 12, label: "营业执照年限", unit: "月" },
      { field: "creditInquiries3m", max: 10, label: "近3月征信查询", unit: "次" },
    ],
    boolean: [{ field: "creditOverdue", equals: false, label: "无当前逾期" }],
    companyTypes: ["self_employed", "private"],
    ageMin: 25,
    ageMax: 60,
    referenceRate: "年化 3.5%~9%（参考区间，非承诺，由机构核定）",
    updatedAt: "2026-08-28",
    notes: "多数机构要求对公流水，需另行提供",
  },
];

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
