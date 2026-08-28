import { z } from "zod";
import {
  NUMERIC_FIELDS,
  BOOLEAN_FIELDS,
  approxNumberSchema,
  incomeBasisSchema,
} from "../extract/types";

/**
 * 标注表单的字段元数据。
 *
 * 这里的 hint 直接来自《标注规范 v1.0》，目的是让口径出现在填写框旁边，
 * 而不是让标注人去翻文档 —— 翻文档的成本会导致凭记忆标，
 * 而凭记忆标是标注一致性下降的主要原因。
 */

export type NumericFieldMeta = {
  key: (typeof NUMERIC_FIELDS)[number];
  label: string;
  /** 硬阈值字段。抽错代价最高，eval 单独统计 */
  hard: boolean;
  unit: string;
  /** 规范速查：直接显示在输入框旁 */
  hint: string;
};

export const NUMERIC_META: NumericFieldMeta[] = [
  {
    key: "monthlyIncome",
    label: "月收入",
    hard: true,
    unit: "元",
    hint: "一万多→10000~19999；一万五左右→14000~16000；到手一万+提成一万五→10000~15000（取波动区间，不标15000）",
  },
  {
    key: "socialSecurityMonths",
    label: "社保连续月数",
    hard: true,
    unit: "月",
    hint: "问的是「连续」不是累计。断缴后「加起来三年」→ 留空+备注。三年多→36~47；快三年→30~35",
  },
  {
    key: "providentFundMonths",
    label: "公积金连续月数",
    hard: true,
    unit: "月",
    hint: "同社保。「一直有交」→ 月数留空，但下面 hasProvidentFund 选「是」",
  },
  {
    key: "creditInquiries3m",
    label: "近3月征信查询次数",
    hard: true,
    unit: "次",
    hint: "窗口是近3月。半年查5次→留空+备注。没查过→0（不是留空）。好几次→3~6",
  },
  {
    key: "debtMonthly",
    label: "每月还款总额",
    hard: true,
    unit: "元",
    hint: "「信用卡刷了不少」无数值 → 留空。不要由有房贷推金额",
  },
  {
    key: "businessMonths",
    label: "营业执照年限",
    hard: true,
    unit: "月",
    hint: "仅企业主/个体户适用。工薪族留空",
  },
  {
    key: "amountIntent",
    label: "意向金额",
    hard: false,
    unit: "元",
    hint: "二三十万→200000~300000；越多越好→留空；至少二十万→min=200000，max 留空",
  },
];

export type BooleanFieldMeta = {
  key: (typeof BOOLEAN_FIELDS)[number];
  label: string;
  hint: string;
};

export const BOOLEAN_META: BooleanFieldMeta[] = [
  {
    key: "creditOverdue",
    label: "有逾期记录",
    hint: "明确说「没逾期过」→否。完全没提→未提及。「信用卡老忘还」→是（行为陈述，非推测）",
  },
  {
    key: "hasMortgage",
    label: "有房贷",
    hint: "「有套房」但没说贷款 →【未提及】，不要推。「全款买的」→否",
  },
  {
    key: "hasCarLoan",
    label: "有车贷",
    hint: "同房贷逻辑。有车≠有车贷。「全款买的车」→否；只说「有辆车」→未提及",
  },
  {
    key: "hasProvidentFund",
    label: "有公积金",
    hint: "「在国企上班」不能推出有公积金 →未提及",
  },
];

export const COMPANY_TYPE_OPTIONS = [
  { value: "state", label: "国企/事业/公务员" },
  { value: "private", label: "民企/一般企业" },
  { value: "foreign", label: "外企" },
  { value: "self_employed", label: "个体/自由职业/自己开公司" },
  { value: "none", label: "无业" },
] as const;

export const INCOME_BASIS_OPTIONS = [
  { value: "pretax", label: "税前" },
  { value: "aftertax", label: "税后/到手" },
  { value: "unknown", label: "未说明" },
] as const;

/**
 * 标注答案的结构。与 extractionSchema 字段一致 —— 必须一致，
 * 否则 eval 时 gold 与 predicted 无法逐字段比对。
 */
export const goldAnswerSchema = z.object({
  monthlyIncome: approxNumberSchema.nullable(),
  incomeBasis: incomeBasisSchema,
  socialSecurityMonths: approxNumberSchema.nullable(),
  providentFundMonths: approxNumberSchema.nullable(),
  creditInquiries3m: approxNumberSchema.nullable(),
  debtMonthly: approxNumberSchema.nullable(),
  businessMonths: approxNumberSchema.nullable(),
  amountIntent: approxNumberSchema.nullable(),

  creditOverdue: z.boolean().nullable(),
  hasMortgage: z.boolean().nullable(),
  hasCarLoan: z.boolean().nullable(),
  hasProvidentFund: z.boolean().nullable(),

  age: z.number().int().min(16).max(100).nullable(),
  city: z.string().max(50).nullable(),
  companyType: z
    .enum(["state", "private", "foreign", "self_employed", "none"])
    .nullable(),
});

export type GoldAnswer = z.infer<typeof goldAnswerSchema>;

/** 新建/更新标注的入参 */
export const goldLabelInputSchema = z.object({
  setName: z.string().min(1).max(50).default("gold_v1"),
  rawText: z.string().min(10, "对话原文太短，至少 10 字"),
  expected: goldAnswerSchema,
  origin: z.enum(["real", "synthetic"]),
  note: z.string().max(2000).nullable().default(null),
  hasCorrection: z.boolean().default(false),
  pendingReview: z.boolean().default(false),
});

export type GoldLabelInput = z.infer<typeof goldLabelInputSchema>;

/** 全空答案，表单初始值 */
export const EMPTY_ANSWER: GoldAnswer = {
  monthlyIncome: null,
  incomeBasis: null,
  socialSecurityMonths: null,
  providentFundMonths: null,
  creditInquiries3m: null,
  debtMonthly: null,
  businessMonths: null,
  amountIntent: null,
  creditOverdue: null,
  hasMortgage: null,
  hasCarLoan: null,
  hasProvidentFund: null,
  age: null,
  city: null,
  companyType: null,
};
