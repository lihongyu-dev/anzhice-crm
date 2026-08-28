import { describe, it, expect } from "vitest";
import { validateExtraction, hasBlockingViolation } from "./validate";
import { conservativeValue, displayValue, type ExtractionResult } from "./types";

/**
 * 这些用例全部来自 2026-08-26 对 qwen-plus 的真实实测输出，
 * 不是凭想象编的边界条件。
 */

const empty: ExtractionResult = {
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

const approx = (min: number, max: number, rawText: string) => ({
  value: null,
  min,
  max,
  isApproximate: true,
  rawText,
});

const exact = (value: number, rawText: string) => ({
  value,
  min: value,
  max: value,
  isApproximate: false,
  rawText,
});

describe("① 跨字段污染（实测最严重的错误）", () => {
  it("输入「社保两年整」时公积金被填了同一个值，应降级公积金", () => {
    // 真实输出：社保和公积金都是 24，rawText 都是「两年整」
    const { data, violations, reviewFields } = validateExtraction({
      ...empty,
      socialSecurityMonths: exact(24, "两年整"),
      providentFundMonths: exact(24, "两年整"),
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("cross_contamination");
    // 第一个字段保留，后面的降级
    expect(data.socialSecurityMonths?.needsReview).toBeUndefined();
    expect(data.providentFundMonths?.needsReview).toBe(true);
    expect(reviewFields).toContain("providentFundMonths");
  });

  it("「收入一万五到两万」被同时填进意向金额，应降级", () => {
    const { violations, reviewFields } = validateExtraction({
      ...empty,
      monthlyIncome: approx(15000, 20000, "一万五到两万之间"),
      amountIntent: approx(15000, 20000, "一万五到两万之间"),
    });

    expect(violations.some((v) => v.kind === "cross_contamination")).toBe(true);
    expect(reviewFields).toContain("amountIntent");
  });

  it("三个字段共用同一原文，降级后两个", () => {
    const { reviewFields } = validateExtraction({
      ...empty,
      monthlyIncome: exact(12000, "一万二"),
      debtMonthly: exact(12000, "一万二"),
      amountIntent: exact(12000, "一万二"),
    });
    expect(reviewFields).toHaveLength(2);
  });

  it("原文不同的字段互不影响", () => {
    const { violations } = validateExtraction({
      ...empty,
      monthlyIncome: exact(12000, "一万二"),
      providentFundMonths: approx(36, 47, "三年多"),
    });
    expect(violations).toHaveLength(0);
  });

  it("空 rawText 不参与污染判定（否则会误报）", () => {
    const { violations } = validateExtraction({
      ...empty,
      monthlyIncome: { value: null, min: null, max: null, isApproximate: false, rawText: "" },
      debtMonthly: { value: null, min: null, max: null, isApproximate: false, rawText: "" },
    });
    expect(violations.filter((v) => v.kind === "cross_contamination")).toHaveLength(0);
  });
});

describe("② 精确值被当成模糊值（反向错误）", () => {
  it("「2次」是确定数字，被标 approximate 应报违规", () => {
    // 真实输出：客户说「上个月查了2次征信」，模型给了 ~[2,5]
    const { violations, reviewFields } = validateExtraction({
      ...empty,
      creditInquiries3m: approx(2, 5, "2次"),
    });

    expect(violations.some((v) => v.kind === "false_approximate")).toBe(true);
    expect(reviewFields).toContain("creditInquiries3m");
  });

  it("「两年整」含确定词，标 approximate 应报违规", () => {
    const { violations } = validateExtraction({
      ...empty,
      socialSecurityMonths: approx(20, 24, "两年整"),
    });
    expect(violations.some((v) => v.kind === "false_approximate")).toBe(true);
  });

  it("「三年多」确实是模糊的，不应误报", () => {
    const { violations } = validateExtraction({
      ...empty,
      providentFundMonths: approx(36, 47, "三年多"),
    });
    expect(violations).toHaveLength(0);
  });

  it("「一万五左右」含数字但有模糊词，不误报", () => {
    const { violations } = validateExtraction({
      ...empty,
      monthlyIncome: approx(13500, 16500, "一万五左右"),
    });
    expect(violations).toHaveLength(0);
  });

  it("「好几次」是模糊的，不误报", () => {
    const { violations } = validateExtraction({
      ...empty,
      creditInquiries3m: approx(3, 8, "好几次"),
    });
    expect(violations).toHaveLength(0);
  });
});

describe("③ 自相矛盾", () => {
  it("标 approximate 却给精确 value，应清空 value", () => {
    const { data, violations } = validateExtraction({
      ...empty,
      providentFundMonths: { value: 40, min: 36, max: 47, isApproximate: true, rawText: "三年多" },
    });

    expect(violations.some((v) => v.kind === "self_contradiction")).toBe(true);
    expect(data.providentFundMonths?.value).toBeNull();
    expect(data.providentFundMonths?.needsReview).toBe(true);
  });

  it("min > max 应交换并报违规", () => {
    const { data, violations } = validateExtraction({
      ...empty,
      monthlyIncome: { value: null, min: 20000, max: 15000, isApproximate: true, rawText: "一万五到两万" },
    });

    expect(violations.some((v) => v.kind === "range_invalid")).toBe(true);
    expect(data.monthlyIncome?.min).toBe(15000);
    expect(data.monthlyIncome?.max).toBe(20000);
  });

  it("模糊却没给区间，无法用于阈值判断，应报违规", () => {
    const { violations } = validateExtraction({
      ...empty,
      socialSecurityMonths: { value: null, min: null, max: null, isApproximate: true, rawText: "挺久了" },
    });
    expect(violations.some((v) => v.kind === "range_invalid")).toBe(true);
  });

  it("精确字段缺 value 但 min===max 时自动补齐", () => {
    const { data } = validateExtraction({
      ...empty,
      socialSecurityMonths: { value: null, min: 24, max: 24, isApproximate: false, rawText: "两年整" },
    });
    expect(data.socialSecurityMonths?.value).toBe(24);
  });
});

describe("未提及字段保持 null（不能被当成 0 或 false）", () => {
  it("全空输入不产生任何违规", () => {
    const { violations, reviewFields } = validateExtraction(empty);
    expect(violations).toHaveLength(0);
    expect(reviewFields).toHaveLength(0);
  });

  it("null 字段校验后仍是 null", () => {
    const { data } = validateExtraction({ ...empty, monthlyIncome: exact(12000, "一万二") });
    expect(data.socialSecurityMonths).toBeNull();
    expect(data.creditOverdue).toBeNull();
  });
});

describe("保守取值（硬阈值判断的核心规则）", () => {
  it("精确值直接返回", () => {
    expect(conservativeValue(exact(24, "两年整"))).toBe(24);
    });

  it("模糊值取 min，不取中值也不取 max", () => {
    // 「三年多」= 36~47，判断「≥40 个月」时必须按 36 算 → 不通过
    expect(conservativeValue(approx(36, 47, "三年多"))).toBe(36);
  });

  it("未提及返回 null，调用方必须显式处理", () => {
    expect(conservativeValue(null)).toBeNull();
  });
});

describe("界面展示", () => {
  it("精确值直接显示数字", () => {
    expect(displayValue(exact(12000, "一万二"))).toBe("12000");
  });

  it("模糊值显示区间并标注估算", () => {
    expect(displayValue(approx(36, 47, "三年多"))).toBe("36~47（估）");
  });

  it("未提及显示提示文案", () => {
    expect(displayValue(null)).toBe("未提及");
  });
});

describe("阻断性违规判定", () => {
  it("跨字段污染属于阻断级", () => {
    expect(
      hasBlockingViolation([
        { field: "providentFundMonths", kind: "cross_contamination", detail: "" },
      ])
    ).toBe(true);
  });

  it("false_approximate 只需人工复核，不阻断", () => {
    expect(
      hasBlockingViolation([{ field: "creditInquiries3m", kind: "false_approximate", detail: "" }])
    ).toBe(false);
  });
});

describe("不修改入参（纯函数）", () => {
  it("原始对象不被污染", () => {
    const input: ExtractionResult = {
      ...empty,
      providentFundMonths: { value: 40, min: 36, max: 47, isApproximate: true, rawText: "三年多" },
    };
    validateExtraction(input);
    // 入参里的 value 应保持原样，修改只发生在返回值上
    expect(input.providentFundMonths?.value).toBe(40);
  });
});
