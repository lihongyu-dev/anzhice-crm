import { describe, it, expect } from "vitest";
import type { ApproxNumber, ExtractionResult } from "../extract/types";
import { matchAll, matchProduct } from "./engine";
import { getProduct, PRODUCTS } from "./products";

/**
 * 规则引擎测试。
 *
 * 重点不是覆盖率数字，而是把三条设计原则钉死，防止后人"优化"掉：
 *   ① null 是 unknown，绝不能当 false
 *   ② 模糊值取保守下界
 *   ③ 只输出可尝试/不满足公开条件，绝不出现审批类表述
 */

function approx(
  partial: Partial<ApproxNumber> & { value?: number | null }
): ApproxNumber {
  return {
    value: partial.value ?? null,
    min: partial.min ?? null,
    max: partial.max ?? null,
    isApproximate: partial.isApproximate ?? false,
    rawText: partial.rawText ?? "",
  };
}

function exact(n: number, raw = ""): ApproxNumber {
  return approx({ value: n, min: n, max: n, isApproximate: false, rawText: raw });
}

function vague(min: number, max: number, raw: string): ApproxNumber {
  return approx({ value: null, min, max, isApproximate: true, rawText: raw });
}

/** 全字段未知的空白资质 */
function blank(): ExtractionResult {
  return {
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
}

describe("三态判定：unknown 不等于 fail", () => {
  it("全部字段未知时，不产生任何 blocker，只产生 missing", () => {
    const r = matchAll(blank());
    for (const m of r.matches) {
      expect(m.blockers).toHaveLength(0);
      expect(m.status).toBe("need_info");
      expect(m.missing.length).toBeGreaterThan(0);
    }
    expect(r.summary.notEligible).toBe(0);
  });

  it("布尔字段为 null 时判 unknown，不判 fail", () => {
    // 「有套房」但没说有没有房贷 → hasMortgage 必须是 null
    const q = blank();
    q.monthlyIncome = exact(20000);
    q.creditInquiries3m = exact(2);
    const m = matchProduct(q, getProduct("mortgage-second")!);
    const mortgageCheck = m.checks.find((c) => c.field === "hasMortgage")!;
    expect(mortgageCheck.status).toBe("unknown");
    expect(m.status).toBe("need_info");
  });

  it("布尔字段为 false 且要求 false 时判 pass（区别于 null）", () => {
    const q = blank();
    q.hasCarLoan = false; // 全款买的车
    q.creditInquiries3m = exact(3);
    q.age = 35;
    const m = matchProduct(q, getProduct("car-pledge")!);
    expect(m.status).toBe("eligible");
  });
});

describe("模糊值取保守下界", () => {
  it("「一万多」按 10000 判定，不按 19999", () => {
    const q = blank();
    // 社保要求 ≥12 月，这里给「一年多」= 12~23
    q.monthlyIncome = vague(10000, 19999, "一万多");
    q.socialSecurityMonths = vague(12, 23, "一年多");
    q.creditInquiries3m = exact(2);
    q.creditOverdue = false;
    q.hasProvidentFund = true;
    q.debtMonthly = exact(3000);
    q.age = 30;

    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    const income = m.checks.find((c) => c.field === "monthlyIncome")!;
    expect(income.status).toBe("pass");
    // 判定理由里必须是下界 10000，不能是 19999
    expect(income.reason).toContain("10000");
    expect(income.reason).not.toContain("19999");
  });

  it("模糊下界不足时判 fail，不因上界够而放过", () => {
    const q = blank();
    // 「三千到六千」下界 3000 < 要求 5000
    q.monthlyIncome = vague(3000, 6000, "三四千到五六千");
    q.socialSecurityMonths = exact(24);
    q.creditInquiries3m = exact(1);
    q.creditOverdue = false;
    q.hasProvidentFund = true;
    q.age = 30;

    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    expect(m.status).toBe("not_eligible");
    const income = m.blockers.find((c) => c.field === "monthlyIncome")!;
    expect(income.reason).toContain("3000");
  });

  it("判定理由里带客户原文，便于人工复核", () => {
    const q = blank();
    q.monthlyIncome = vague(10000, 19999, "一万多");
    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    const income = m.checks.find((c) => c.field === "monthlyIncome")!;
    expect(income.reason).toContain("一万多");
  });
});

describe("上限类规则：征信查询次数", () => {
  it("超过上限时 fail，且理由说明超了多少", () => {
    const q = blank();
    q.creditInquiries3m = exact(8, "查了八次");
    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    const c = m.blockers.find((x) => x.field === "creditInquiries3m")!;
    expect(c.status).toBe("fail");
    expect(c.reason).toContain("8");
    expect(c.reason).toContain("6"); // 该产品上限
  });

  it("0 次是有效值，不能当作未提及", () => {
    const q = blank();
    q.creditInquiries3m = exact(0, "没查过");
    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    const c = m.checks.find((x) => x.field === "creditInquiries3m")!;
    expect(c.status).toBe("pass");
  });
});

describe("负债收入比", () => {
  it("超过 70% 判 fail", () => {
    const q = blank();
    q.monthlyIncome = exact(10000);
    q.debtMonthly = exact(8000);
    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    const c = m.checks.find((x) => x.field === "debtIncomeRatio")!;
    expect(c.status).toBe("fail");
    expect(c.reason).toContain("80%");
  });

  it("恰好 70% 判 pass（边界含等号）", () => {
    const q = blank();
    q.monthlyIncome = exact(10000);
    q.debtMonthly = exact(7000);
    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    const c = m.checks.find((x) => x.field === "debtIncomeRatio")!;
    expect(c.status).toBe("pass");
  });

  it("缺任一项时 unknown，并说明缺哪一项", () => {
    const q = blank();
    q.monthlyIncome = exact(10000);
    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    const c = m.checks.find((x) => x.field === "debtIncomeRatio")!;
    expect(c.status).toBe("unknown");
    expect(c.reason).toContain("月还款总额");
  });
});

describe("fail 优先于 unknown", () => {
  it("已有明确不满足项时判 not_eligible，即使还有字段未知", () => {
    const q = blank();
    q.creditInquiries3m = exact(20); // 明确超限
    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    expect(m.status).toBe("not_eligible");
    expect(m.missing.length).toBeGreaterThan(0); // 确实还有未知项
  });
});

describe("排序与补齐建议", () => {
  it("eligible 排在 need_info 之前，need_info 排在 not_eligible 之前", () => {
    const q = blank();
    q.hasCarLoan = false;
    q.creditInquiries3m = exact(3);
    q.age = 35;
    q.creditOverdue = false;

    const r = matchAll(q);
    const order = r.matches.map((m) => m.status);
    const rank = { eligible: 0, need_info: 1, not_eligible: 2 } as const;
    for (let i = 1; i < order.length; i++) {
      expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]]);
    }
  });

  it("topMissingFields 按跨产品出现次数降序，用于决定先问什么", () => {
    const r = matchAll(blank());
    expect(r.topMissingFields.length).toBeGreaterThan(0);
    for (let i = 1; i < r.topMissingFields.length; i++) {
      expect(r.topMissingFields[i].count).toBeLessThanOrEqual(
        r.topMissingFields[i - 1].count
      );
    }
    // 征信查询次数是所有 5 款产品的共同门槛，应排在最前
    expect(r.topMissingFields[0].field).toBe("creditInquiries3m");
  });

  it("按产品大类筛选", () => {
    const r = matchAll(blank(), { category: "credit" });
    expect(r.matches.length).toBe(
      PRODUCTS.filter((p) => p.category === "credit").length
    );
    for (const m of r.matches) expect(m.category).toBe("credit");
  });
});

describe("合规：措辞不得越界", () => {
  const FORBIDDEN = ["通过", "拒批", "包过", "放款", "审批", "批款", "秒批"];

  it("所有产品的参考利率必须声明为参考区间且非承诺", () => {
    for (const p of PRODUCTS) {
      expect(p.referenceRate).toContain("参考区间");
      expect(p.referenceRate).toContain("非承诺");
    }
  });

  /**
   * 只扫判定理由与标签，**不扫免责声明**。
   *
   * 免责声明里必须出现“不构成任何放款承诺”——
   * 否定“放款”正是合规要求，把它当违规就本末倒置了。
   * （2026-08-28 首版测试就犯了这个错：粗暴扫整个 JSON，
   * 把声明里的正当否定误判成违规。限定范围才是对的。）
   */
  it("判定理由与标签中不得出现审批类表述", () => {
    const q = blank();
    q.monthlyIncome = exact(20000);
    q.socialSecurityMonths = exact(24);
    q.creditInquiries3m = exact(15); // 造出 fail
    q.debtMonthly = exact(20000); // 造出 fail
    q.creditOverdue = true;
    q.hasProvidentFund = false;
    q.hasMortgage = false;
    q.hasCarLoan = true;
    q.businessMonths = exact(3);
    q.age = 70;
    q.companyType = "none";

    const r = matchAll(q);

    const texts: string[] = [];
    for (const m of r.matches) {
      texts.push(m.productName);
      if (m.notes) texts.push(m.notes);
      for (const c of m.checks) {
        texts.push(c.label, c.reason);
      }
    }

    for (const t of texts) {
      for (const w of FORBIDDEN) {
        expect(t, `违规措辞「${w}」出现在：${t}`).not.toContain(w);
      }
    }
  });

  it("免责声明必须显式否定放款承诺与审批结论", () => {
    const r = matchAll(blank());
    expect(r.disclaimer).toContain("非审批结论");
    expect(r.disclaimer).toContain("不构成任何放款承诺");
    expect(r.disclaimer).toContain("持牌机构");
  });

  it("匹配状态只有三种，不引入审批语义的第四种", () => {
    const r = matchAll(blank());
    for (const m of r.matches) {
      expect(["eligible", "need_info", "not_eligible"]).toContain(m.status);
    }
  });
});

describe("完整用例：一个应当匹配上的客户", () => {
  it("条件齐全的工薪客户匹配到 A 档", () => {
    const q = blank();
    q.monthlyIncome = exact(15000, "到手一万五");
    q.incomeBasis = "aftertax";
    q.socialSecurityMonths = exact(36, "三年");
    q.providentFundMonths = exact(36);
    q.hasProvidentFund = true;
    q.creditInquiries3m = exact(2, "查过两次");
    q.debtMonthly = exact(4000, "每月还四千");
    q.creditOverdue = false;
    q.age = 32;
    q.companyType = "private";

    const m = matchProduct(q, getProduct("credit-salaried-a")!);
    expect(m.status).toBe("eligible");
    expect(m.blockers).toHaveLength(0);
    expect(m.missing).toHaveLength(0);
  });
});
