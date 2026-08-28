import type { ApproxNumber } from "../extract/types";
import { EMPTY_ANSWER, type GoldAnswer } from "../gold/fields";

/**
 * 合成标注集 gold_v1（synthetic 部分）。
 *
 * ⚠️ 这些是**人造对话**，不是真实客户记录。origin 一律 'synthetic'，
 * eval 报告必须披露。真实对话后续增量补进来，届时分开统计
 * —— 合成样本的准确率通常偏高（措辞比真人规整），
 * 拿它当"真实性能"汇报是自欺，面试时也一问就穿。
 *
 * 合成样本的真正作用：**每条针对一个已知失效模式**，
 * 用来验证管线能不能抓到该类错误。这是回归测试集，不是性能基准。
 *
 * 设计依据：2026-08-26 qwen-plus 实测暴露的三类错误
 *   ① 跨字段污染 ② 模糊表达输出精确值 ③ 由事实推测未提及项
 * 加上《标注规范 v1.0》的口径裁决。
 */

/** 精确值 */
const ex = (n: number, raw: string): ApproxNumber => ({
  value: n,
  min: n,
  max: n,
  isApproximate: false,
  rawText: raw,
});

/** 模糊区间。max 为 null 表示无上界（如"至少二十万"） */
const ap = (
  min: number | null,
  max: number | null,
  raw: string
): ApproxNumber => ({
  value: null,
  min,
  max,
  isApproximate: true,
  rawText: raw,
});

export type SyntheticSample = {
  rawText: string;
  expected: GoldAnswer;
  /** 这条样本专门考什么失效模式。会写进 note */
  probe: string;
  hasCorrection?: boolean;
  /** 标注规范未完全覆盖的说法 */
  pendingReview?: boolean;
};

export const SYNTHETIC_SAMPLES: SyntheticSample[] = [
  {
    probe: "基线：全字段精确表达，不应出现任何区间",
    rawText: `客户：想咨询下贷款
我：方便说下您的情况吗
客户：我在北京，月薪税前15000，社保连续交了36个月，公积金也是36个月
客户：近三个月查了2次征信，没有逾期，每月还款3000
客户：想借30万`,
    expected: {
      ...EMPTY_ANSWER,
      monthlyIncome: ex(15000, "月薪税前15000"),
      incomeBasis: "pretax",
      socialSecurityMonths: ex(36, "社保连续交了36个月"),
      providentFundMonths: ex(36, "公积金也是36个月"),
      hasProvidentFund: true,
      creditInquiries3m: ex(2, "近三个月查了2次征信"),
      creditOverdue: false,
      debtMonthly: ex(3000, "每月还款3000"),
      amountIntent: ex(300000, "想借30万"),
      city: "北京",
    },
  },
  {
    probe: "8/26 实测原案。「三年多」必须是 36~47 区间，输出 40 即为 over_precise。同时社保未提，填了就是 hallucination",
    rawText: `客户：我想问下贷款的事
我：您好，方便说下大概情况吗
客户：我月薪一万二 在北京 有个房贷还着 公积金交了三年多了
客户：上个月查过两次征信 没逾期过
客户：想借三十万左右`,
    expected: {
      ...EMPTY_ANSWER,
      monthlyIncome: ex(12000, "月薪一万二"),
      incomeBasis: "unknown",
      hasMortgage: true,
      providentFundMonths: ap(36, 47, "公积金交了三年多了"),
      hasProvidentFund: true,
      creditInquiries3m: ex(2, "上个月查过两次征信"),
      creditOverdue: false,
      amountIntent: ap(280000, 320000, "想借三十万左右"),
      city: "北京",
    },
  },
  {
    probe: "跨字段污染核心用例：只提社保，公积金必须为 null",
    rawText: `客户：社保交了两年整，想问下能贷多少`,
    expected: {
      ...EMPTY_ANSWER,
      socialSecurityMonths: ex(24, "社保交了两年整"),
    },
  },
  {
    probe: "0 与 null 的区分：「没查过」是明确信息，值为 0 不是 null",
    rawText: `客户：征信我没查过，月薪8000`,
    expected: {
      ...EMPTY_ANSWER,
      creditInquiries3m: ex(0, "征信我没查过"),
      monthlyIncome: ex(8000, "月薪8000"),
      incomeBasis: "unknown",
    },
  },
  {
    probe: "推测陷阱：「有套房」没提贷款，hasMortgage 必须 null 不是 true",
    rawText: `客户：我名下有套房，月收入两万`,
    expected: {
      ...EMPTY_ANSWER,
      hasMortgage: null,
      monthlyIncome: ex(20000, "月收入两万"),
      incomeBasis: "unknown",
    },
  },
  {
    probe: "推测陷阱：「在国企上班」不能推出有公积金",
    rawText: `客户：我在国企上班，月薪一万`,
    expected: {
      ...EMPTY_ANSWER,
      companyType: "state",
      monthlyIncome: ex(10000, "月薪一万"),
      incomeBasis: "unknown",
      hasProvidentFund: null,
    },
  },
  {
    probe: "中途改口：必须取最后一次陈述 12000，不是首次的 10000",
    rawText: `客户：我月薪一万
我：好的
客户：哦不对，加上提成是一万二`,
    expected: {
      ...EMPTY_ANSWER,
      monthlyIncome: ex(12000, "加上提成是一万二"),
      incomeBasis: "unknown",
    },
    hasCorrection: true,
  },
  {
    probe: "模糊换算：「一万多」→ 10000~19999",
    rawText: `客户：月薪一万多，在北京`,
    expected: {
      ...EMPTY_ANSWER,
      monthlyIncome: ap(10000, 19999, "月薪一万多"),
      incomeBasis: "unknown",
      city: "北京",
    },
  },
  {
    probe: "「越多越好」没有数值信息，amountIntent 必须 null",
    rawText: `客户：能贷多少算多少，越多越好，我月薪一万五`,
    expected: {
      ...EMPTY_ANSWER,
      amountIntent: null,
      monthlyIncome: ex(15000, "月薪一万五"),
      incomeBasis: "unknown",
    },
  },
  {
    probe: "单边区间：「至少二十万」min=200000，max 必须 null",
    rawText: `客户：至少要二十万，少了没意义`,
    expected: {
      ...EMPTY_ANSWER,
      amountIntent: ap(200000, null, "至少要二十万"),
    },
  },
  {
    probe: "窗口不匹配：「半年查5次」超出近3月窗口，必须 null 不能填 5",
    rawText: `客户：这半年查了5次征信，月薪九千`,
    expected: {
      ...EMPTY_ANSWER,
      creditInquiries3m: null,
      monthlyIncome: ex(9000, "月薪九千"),
      incomeBasis: "unknown",
    },
  },
  {
    probe: "连续性不满足：断缴后「加起来三年」不是连续月数，必须 null",
    rawText: `客户：社保断过，加起来交了三年`,
    expected: {
      ...EMPTY_ANSWER,
      socialSecurityMonths: null,
    },
  },
  {
    probe: "流水 ≠ 收入。月流水五万不能填进 monthlyIncome",
    rawText: `客户：我自己开店的，营业执照办了整三年，想做经营贷，店里月流水五万`,
    expected: {
      ...EMPTY_ANSWER,
      companyType: "self_employed",
      businessMonths: ex(36, "营业执照办了整三年"),
      monthlyIncome: null,
    },
  },
  {
    probe: "收入口径：「到手」→ aftertax",
    rawText: `客户：到手一万二，在北京`,
    expected: {
      ...EMPTY_ANSWER,
      monthlyIncome: ex(12000, "到手一万二"),
      incomeBasis: "aftertax",
      city: "北京",
    },
  },
  {
    probe: "「一直交着」→ 布尔为 true 但月数必须 null（不许编月数）",
    rawText: `客户：税前一万五，公积金一直交着`,
    expected: {
      ...EMPTY_ANSWER,
      monthlyIncome: ex(15000, "税前一万五"),
      incomeBasis: "pretax",
      hasProvidentFund: true,
      providentFundMonths: null,
    },
  },
  {
    probe: "模糊次数：「好几次」→ 3~6 区间",
    rawText: `客户：最近三个月查了好几次征信`,
    expected: {
      ...EMPTY_ANSWER,
      creditInquiries3m: ap(3, 6, "最近三个月查了好几次征信"),
    },
  },
  {
    probe: "明确否定：「全款买的」→ hasMortgage false，不是 null",
    rawText: `客户：房子是全款买的，没贷款`,
    expected: {
      ...EMPTY_ANSWER,
      hasMortgage: false,
    },
  },
  {
    probe: "有车 ≠ 有车贷，且此处明确否定 → false",
    rawText: `我：名下有车吗
客户：有辆车，全款的，没有车贷`,
    expected: {
      ...EMPTY_ANSWER,
      hasCarLoan: false,
    },
  },
  {
    probe: "行为陈述可判定：「经常逾期」→ creditOverdue true",
    rawText: `客户：信用卡老忘了还，经常逾期`,
    expected: {
      ...EMPTY_ANSWER,
      creditOverdue: true,
    },
  },
  {
    probe: "明确表示记不清 → 月数 null，布尔 true",
    rawText: `客户：公积金一直交着，具体多久记不清了`,
    expected: {
      ...EMPTY_ANSWER,
      hasProvidentFund: true,
      providentFundMonths: null,
    },
  },
  {
    probe: "空信息对话：全字段 null。任何非 null 输出都是 hallucination",
    rawText: `客户：贷款怎么办
我：方便说下您的情况吗
客户：我先了解下`,
    expected: { ...EMPTY_ANSWER },
  },
  {
    probe: "模糊换算：「二三十万」→ 200000~300000",
    rawText: `我：您大概想借多少
客户：想借二三十万，具体看能批多少`,
    expected: {
      ...EMPTY_ANSWER,
      amountIntent: ap(200000, 300000, "想借二三十万"),
    },
  },
  {
    probe: "模糊换算：「快三年」→ 30~35，与「三年多」方向相反",
    rawText: `我：社保交了多久
客户：社保快三年了，一直没断过`,
    expected: {
      ...EMPTY_ANSWER,
      socialSecurityMonths: ap(30, 35, "社保快三年了"),
    },
  },
  {
    probe: "多字段综合 + 由还款项反推房贷车贷存在（此处客户明说了）",
    rawText: `客户：我35岁，在北京一家民企，税后一万八，每月房贷车贷加起来还八千
客户：社保连续四年，公积金也四年，近三个月没查过征信，从没逾期
客户：想借五十万`,
    expected: {
      ...EMPTY_ANSWER,
      age: 35,
      city: "北京",
      companyType: "private",
      monthlyIncome: ex(18000, "税后一万八"),
      incomeBasis: "aftertax",
      debtMonthly: ex(8000, "每月房贷车贷加起来还八千"),
      hasMortgage: true,
      hasCarLoan: true,
      socialSecurityMonths: ex(48, "社保连续四年"),
      providentFundMonths: ex(48, "公积金也四年"),
      hasProvidentFund: true,
      creditInquiries3m: ex(0, "近三个月没查过征信"),
      creditOverdue: false,
      amountIntent: ex(500000, "想借五十万"),
    },
  },
];
