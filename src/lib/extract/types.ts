import { z } from "zod";

/**
 * 抽取输出的类型定义与校验。
 *
 * 设计依据（2026-08-26 实测）：
 * qwen-plus 在裸 number 字段上会把「三年多」编成 40。
 * 所以数值字段统一用区间结构，并在代码层做交叉校验。
 */

export const approxNumberSchema = z.object({
  /** 客户明确说出的精确值；模糊表达时必须为 null */
  value: z.number().nullable(),
  /** 保守下界。硬阈值判断只认这个 */
  min: z.number().nullable(),
  max: z.number().nullable(),
  isApproximate: z.boolean(),
  /** 原文依据，如「三年多」。交叉校验靠它发现字段串味 */
  rawText: z.string(),
  /** 校验降级标记，由 validate.ts 写入 */
  needsReview: z.boolean().optional(),
});

export type ApproxNumber = z.infer<typeof approxNumberSchema>;

/** 数值型资质字段（全部可为 null = 对话里没提） */
export const NUMERIC_FIELDS = [
  "monthlyIncome",
  "socialSecurityMonths",
  "providentFundMonths",
  "creditInquiries3m",
  "debtMonthly",
  "businessMonths",
  "amountIntent",
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];

/** 布尔型字段。null 表示未提及，不等于 false —— 这个区分很重要 */
export const BOOLEAN_FIELDS = [
  "creditOverdue",
  "hasMortgage",
  /**
   * 语义是「有车贷」，不是「有车」。
   * 2026-08-28 eval 实测：原名 hasCar 导致 qwen-plus 在
   * 「有辆车，全款的，没有车贷」上输出 true —— 字段名本身在误导模型。
   * 命名即 prompt，这个改名是修 bug，不是洁癖。
   */
  "hasCarLoan",
  "hasProvidentFund",
] as const;

/**
 * 收入口径。标注规范 v1.0 裁决 4.1-A。
 *
 * 为什么需要这个字段：客户说「月薪一万二」时税前税后未知，
 * 强行统一成税前需要社保比例和个税依据 —— 我们没有，一换算就变成推测。
 * 加一列比丢弃样本诚实，规则引擎也能据此决定要不要人工确认。
 */
export const incomeBasisSchema = z
  .enum(["pretax", "aftertax", "unknown"])
  .nullable();

export type IncomeBasis = z.infer<typeof incomeBasisSchema>;

/**
 * 学历。从低到高有序 —— 顺序就是语义，规则引擎靠它做「≥ 本科」这类判断。
 *
 * 为什么用有序枚举而不是自由文本：
 * 客户会说「大专」「大学」「本科」「研究生」「硕士」，存原文就无法比大小。
 * 但归一时有一个真实歧义：「大学毕业」在口语里可能指大专也可能指本科。
 * 所以 prompt 里明确要求：含义不确定时留 null，不猜。
 *
 * 注意没有 "unknown" 选项。学历不同于收入口径：
 * 「提了学历但说不清是哪个级别」在业务上等于没有信息，多一个枚举值
 * 只会让模型多一个逃避 null 的出口。
 */
export const EDUCATION_LEVELS = [
  "below_high_school",
  "high_school",
  "college", // 大专 / 高职
  "bachelor", // 本科
  "master", // 硕士（含在读研究生）
  "doctor",
] as const;

export const educationSchema = z.enum(EDUCATION_LEVELS).nullable();

export type Education = z.infer<typeof educationSchema>;

/** 学历排序用的秩，数字越大越高。规则引擎用它比阈值 */
export const EDUCATION_RANK: Record<(typeof EDUCATION_LEVELS)[number], number> = {
  below_high_school: 0,
  high_school: 1,
  college: 2,
  bachelor: 3,
  master: 4,
  doctor: 5,
};

export const EDUCATION_LABELS: Record<(typeof EDUCATION_LEVELS)[number], string> = {
  below_high_school: "高中以下",
  high_school: "高中/中专",
  college: "大专",
  bachelor: "本科",
  master: "硕士",
  doctor: "博士",
};

/**
 * 模型输出的 schema。
 *
 * 每个字段都带 .default(null)，作用是**容忍模型漏键**。
 *
 * 2026-08-28 eval 实测：qwen-plus 在一条样本上少返回了 companyType 这一个键，
 * 其余 14 个字段全部正确，却因缺键被整条判 schema_invalid（失败率 4.2%）。
 * 这是我们自己的 schema 过于苛刻造成的失败，不是模型的能力问题。
 *
 * 业务上「缺键」和「显式 null」含义相同 —— 都表示这条信息没有。
 * 把两者等价处理是正确的；但缺键仍会被 run.ts 记录下来，
 * 因为它是 prompt 依从性的质量信号，不该静默吞掉。
 */
export const extractionSchema = z.object({
  monthlyIncome: approxNumberSchema.nullable().default(null),
  /** 月收入口径。monthlyIncome 为 null 时此字段必须也是 null */
  incomeBasis: incomeBasisSchema.default(null),
  socialSecurityMonths: approxNumberSchema.nullable().default(null),
  providentFundMonths: approxNumberSchema.nullable().default(null),
  creditInquiries3m: approxNumberSchema.nullable().default(null),
  debtMonthly: approxNumberSchema.nullable().default(null),
  businessMonths: approxNumberSchema.nullable().default(null),
  amountIntent: approxNumberSchema.nullable().default(null),

  creditOverdue: z.boolean().nullable().default(null),
  hasMortgage: z.boolean().nullable().default(null),
  hasCarLoan: z.boolean().nullable().default(null),
  hasProvidentFund: z.boolean().nullable().default(null),

  age: z.number().nullable().default(null),
  city: z.string().nullable().default(null),
  /**
   * 学历。部分信用贷产品把它当准入条件（常见下限是大专）。
   * 归一为有序枚举而不存原文 —— 否则比不了大小，规则引擎用不了。
   */
  education: educationSchema.default(null),
  companyType: z
    .enum(["state", "private", "foreign", "self_employed", "none"])
    .nullable()
    .default(null),
});

/** extractionSchema 的全部键，用于检测模型漏了哪些 */
export const EXTRACTION_KEYS = Object.keys(
  extractionSchema.shape
) as (keyof ExtractionResult)[];

export type ExtractionResult = z.infer<typeof extractionSchema>;

/**
 * 硬阈值判断时的取值。
 * 模糊值一律取 min —— 宁可少推一单，不可推错一单。
 */
export function conservativeValue(f: ApproxNumber | null): number | null {
  if (!f) return null;
  if (!f.isApproximate && f.value !== null) return f.value;
  return f.min;
}

/** 界面展示用 */
export function displayValue(f: ApproxNumber | null): string {
  if (!f) return "未提及";
  if (!f.isApproximate && f.value !== null) return String(f.value);
  if (f.min !== null && f.max !== null) return `${f.min}~${f.max}（估）`;
  return "待确认";
}
