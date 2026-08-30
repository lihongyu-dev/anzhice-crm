import { describe, it, expect } from "vitest";
import {
  mergeVerified,
  nextReviewFields,
  buildQualPatch,
  pickLeadSync,
  changedFields,
  extractFailureMessage,
  isRetryable,
  canReuse,
} from "./persist-logic";
import type { ApproxNumber, ExtractionResult } from "./types";

/**
 * 这些测试守的是**设计约束**，不是行覆盖率。
 *
 * 每个 describe 顶部写的是"哪个约束坏了会怎样"——
 * 如果将来有人为了图方便改掉某处实现，红的那条测试要能说清代价。
 */

const approx = (min: number, max: number, rawText: string): ApproxNumber => ({
  value: null,
  min,
  max,
  isApproximate: true,
  rawText,
});

const exact = (value: number, rawText: string): ApproxNumber => ({
  value,
  min: value,
  max: value,
  isApproximate: false,
  rawText,
});

describe("mergeVerified —— 复核是增量的，不能互相冲掉", () => {
  it("第二次复核不该冲掉第一次确认的字段", () => {
    // 第一通电话确认了收入和社保，第三通才问出公积金
    const r = mergeVerified(["monthlyIncome", "socialSecurityMonths"], [
      "providentFundMonths",
    ]);
    expect(r).toEqual([
      "monthlyIncome",
      "socialSecurityMonths",
      "providentFundMonths",
    ]);
  });

  it("重复确认同一字段不产生重复项", () => {
    const r = mergeVerified(["monthlyIncome"], ["monthlyIncome", "age"]);
    expect(r).toEqual(["monthlyIncome", "age"]);
  });

  it("before 为 null（首次复核）时按空集处理", () => {
    expect(mergeVerified(null, ["age"])).toEqual(["age"]);
  });

  it("本次没勾任何字段时保留原有确认记录", () => {
    // 只改值不勾"已核对"是合法操作，不该把之前确认过的清掉
    expect(mergeVerified(["age"], [])).toEqual(["age"]);
  });
});

describe("nextReviewFields —— 永远亮着的警告灯等于没有警告灯", () => {
  it("已确认的字段必须从待复核清单移除", () => {
    const r = nextReviewFields(
      ["providentFundMonths", "monthlyIncome"],
      ["providentFundMonths"]
    );
    expect(r).toEqual(["monthlyIncome"]);
  });

  it("未确认的待复核字段保持不动", () => {
    const r = nextReviewFields(["providentFundMonths"], ["age"]);
    expect(r).toEqual(["providentFundMonths"]);
  });

  it("全部确认后待复核清单清空", () => {
    const r = nextReviewFields(["a", "b"], ["a", "b", "c"]);
    expect(r).toEqual([]);
  });

  it("原本没有待复核字段时不报错", () => {
    expect(nextReviewFields(null, ["age"])).toEqual([]);
  });
});

describe("buildQualPatch —— 「不传」和「传 null」必须是两件事", () => {
  /**
   * 这一组是整个文件里最重要的测试。
   *
   * 如果实现里写成 `patch.monthlyIncome ?? before.monthlyIncome`，
   * 下面第二条会红 —— 而那种写法会导致**人工无法清空模型编出来的值**，
   * 恰好把复核最核心的功能（修幻觉）废掉。
   */
  it("不传的字段不出现在 patch 里（保持原值）", () => {
    const p = buildQualPatch({ age: 35 });
    expect("monthlyIncome" in p).toBe(false);
    expect(p.age).toBe(35);
  });

  it("显式传 null 必须进 patch —— 这是人工清空模型幻觉的唯一手段", () => {
    const p = buildQualPatch({ hasMortgage: null });
    expect("hasMortgage" in p).toBe(true);
    expect(p.hasMortgage).toBeNull();
  });

  it("false 不会被当成空值丢掉", () => {
    // 「全款买的车」→ hasCarLoan=false，这是明确信息，不是未提及
    const p = buildQualPatch({ hasCarLoan: false });
    expect(p.hasCarLoan).toBe(false);
  });

  it("数值 0 不会被当成空值丢掉", () => {
    // 「没查过征信」→ 0 次，与「没提征信」（null）语义相反
    const p = buildQualPatch({ creditInquiries3m: exact(0, "没查过") });
    expect((p.creditInquiries3m as ApproxNumber).value).toBe(0);
  });

  it("空 patch 产出空对象，不会误清字段", () => {
    expect(buildQualPatch({})).toEqual({});
  });

  it("leads 上的字段不进 qualifications patch", () => {
    // amountIntent / city 属于线索，不属于资质表
    const p = buildQualPatch({
      amountIntent: exact(300000, "三十万"),
      city: "北京",
      age: 30,
    });
    expect("amountIntent" in p).toBe(false);
    expect("city" in p).toBe(false);
    expect(p.age).toBe(30);
  });

  it("覆盖全部 13 个可改字段", () => {
    const full: Partial<ExtractionResult> = {
      monthlyIncome: exact(12000, "一万二"),
      incomeBasis: "aftertax",
      socialSecurityMonths: exact(24, "两年整"),
      providentFundMonths: approx(36, 47, "三年多"),
      creditInquiries3m: exact(2, "查了2次"),
      debtMonthly: exact(5000, "五千"),
      businessMonths: exact(18, "一年半"),
      creditOverdue: false,
      hasMortgage: true,
      hasCarLoan: false,
      hasProvidentFund: true,
      age: 35,
      companyType: "state",
    };
    expect(Object.keys(buildQualPatch(full))).toHaveLength(13);
  });
});

describe("pickLeadSync —— 写进 leads 会丢失信息，所以必须先有人负责", () => {
  it("未确认的意向金额不同步（模型猜的值不落 leads）", () => {
    const r = pickLeadSync([], { amountIntent: exact(300000, "三十万") });
    expect(r.amountIntent).toBeUndefined();
  });

  it("已确认才同步", () => {
    const r = pickLeadSync(["amountIntent"], {
      amountIntent: exact(300000, "三十万"),
    });
    expect(r.amountIntent).toBe(300000);
  });

  it("模糊值取下界 —— 宁可按小的报，报大了推过去被拒客户白跑", () => {
    // 「二三十万」→ 200000~300000，取 200000
    const r = pickLeadSync(["amountIntent"], {
      amountIntent: approx(200000, 300000, "二三十万"),
    });
    expect(r.amountIntent).toBe(200000);
  });

  it("无上界的模糊值（「至少二十万」）仍取下界", () => {
    const r = pickLeadSync(["amountIntent"], {
      amountIntent: {
        value: null,
        min: 200000,
        max: null,
        isApproximate: true,
        rawText: "至少二十万",
      },
    });
    expect(r.amountIntent).toBe(200000);
  });

  it("确认为 null（客户其实没说金额）时不写 leads", () => {
    const r = pickLeadSync(["amountIntent"], { amountIntent: null });
    expect(r.amountIntent).toBeUndefined();
  });

  it("城市空字符串不同步，避免把 leads.city 清成空", () => {
    const r = pickLeadSync(["city"], { city: "   " });
    expect(r.city).toBeUndefined();
  });

  it("城市已确认则同步并去空白", () => {
    const r = pickLeadSync(["city"], { city: " 北京 " });
    expect(r.city).toBe("北京");
  });

  it("两个字段可同时同步", () => {
    const r = pickLeadSync(["amountIntent", "city"], {
      amountIntent: exact(500000, "五十万"),
      city: "北京",
    });
    expect(r).toEqual({ amountIntent: 500000, city: "北京" });
  });
});

describe("changedFields —— 审计的价值来自信噪比", () => {
  it("只记真正变化的字段", () => {
    const before = { age: 30, hasMortgage: true, city: "北京" };
    const patch = { age: 35, hasMortgage: true };
    const d = changedFields(before, patch);
    expect(Object.keys(d)).toEqual(["age"]);
    expect(d.age).toEqual({ from: 30, to: 35 });
  });

  it("值从有到 null 要记 —— 这就是模型幻觉被人工修掉的证据", () => {
    const d = changedFields({ hasMortgage: true }, { hasMortgage: null });
    expect(d.hasMortgage).toEqual({ from: true, to: null });
  });

  it("ApproxNumber 做深比较，内容相同不算变化", () => {
    const v = exact(24, "两年整");
    const d = changedFields(
      { socialSecurityMonths: v },
      { socialSecurityMonths: { ...v } }
    );
    expect(d).toEqual({});
  });

  it("ApproxNumber 内部字段变了要记（40 被改成区间）", () => {
    const d = changedFields(
      { providentFundMonths: exact(40, "三年多") },
      { providentFundMonths: approx(36, 47, "三年多") }
    );
    expect(d.providentFundMonths).toBeDefined();
  });

  it("undefined 与 null 视为同一状态，不产生假变更", () => {
    const d = changedFields({ age: undefined }, { age: null });
    expect(d).toEqual({});
  });
});

describe("失败归因 —— 合并成「抽取失败」等于让人对着不可重试的错反复点重试", () => {
  it("四种失败给出各自的文案", () => {
    expect(extractFailureMessage("api_error")).toContain("可重试");
    expect(extractFailureMessage("timeout")).toContain("可重试");
    expect(extractFailureMessage("parse_error")).toContain("JSON");
    expect(extractFailureMessage("schema_invalid")).toContain("结构");
  });

  it("网络类失败可重试", () => {
    expect(isRetryable("api_error")).toBe(true);
    expect(isRetryable("timeout")).toBe(true);
  });

  it("prompt / schema 类失败重试无用", () => {
    expect(isRetryable("parse_error")).toBe(false);
    expect(isRetryable("schema_invalid")).toBe(false);
  });
});

describe("canReuse —— 去重针对重复花钱，不是重复尝试", () => {
  it("上次成功且有资质记录 → 复用，不重复计费", () => {
    expect(canReuse("ok", true)).toBe(true);
  });

  it("degraded 算成功：数据完整，只是部分字段降级待复核", () => {
    expect(canReuse("degraded", true)).toBe(true);
  });

  it("上次是接口错误 → 必须真跑一次，否则这段对话永远抽不出来", () => {
    expect(canReuse("api_error", true)).toBe(false);
    expect(canReuse("timeout", true)).toBe(false);
  });

  it("上次结构非法 → 重跑（可能 prompt 已经改好了）", () => {
    expect(canReuse("schema_invalid", true)).toBe(false);
  });

  it("有成功记录但没落资质记录 → 不能复用，无东西可复用", () => {
    expect(canReuse("ok", false)).toBe(false);
  });

  it("没有历史 run 记录 → 不复用", () => {
    expect(canReuse(null, true)).toBe(false);
    expect(canReuse(undefined, true)).toBe(false);
  });
});
