import {
  NUMERIC_FIELDS,
  BOOLEAN_FIELDS,
  type ApproxNumber,
  type ExtractionResult,
} from "../extract/types";

/**
 * 逐字段评分。
 *
 * 为什么不用一个笼统的"准确率"：
 * 在贷款资质场景里，错的方式不等价。
 *
 *   模型编了个客户没说的数字（hallucination）→ 可能推错单，客户白跑一趟，
 *     中介那边一次就够毁信任。
 *   模型漏了客户说过的数字（miss）→ 人工补一句就行，代价接近零。
 *
 * 把这两类混在一个百分比里，等于把最贵的错误藏起来。
 * 所以本模块的产出是**错误类型分布**，不是单一分数。
 *
 * 面试要答的就是这个：为什么你的 eval 不只报一个准确率。
 */

export type ErrorKind =
  /** 完全正确 */
  | "correct"
  /** gold 为 null，模型却给了值 —— 凭空编造，最贵 */
  | "hallucination"
  /** gold 有值，模型给 null —— 漏抽，可人工补 */
  | "miss"
  /** gold 是模糊区间，模型给了精确值 —— 8/26 实测到的主要缺陷 */
  | "over_precise"
  /** gold 是精确值，模型给了区间 —— 过度保守，可用但降级 */
  | "over_hedged"
  /** 都有值但数值不符 */
  | "wrong_value";

export type FieldScore = {
  field: string;
  kind: ErrorKind;
  /** 硬阈值字段。抽错直接影响能不能推单 */
  hard: boolean;
  goldRepr: string;
  predRepr: string;
};

/** 硬阈值字段：这些字段错了会直接导致推单判断出错 */
export const HARD_FIELDS = new Set<string>([
  "monthlyIncome",
  "socialSecurityMonths",
  "providentFundMonths",
  "creditInquiries3m",
  "debtMonthly",
  "businessMonths",
]);

function reprApprox(v: ApproxNumber | null): string {
  if (!v) return "null";
  if (!v.isApproximate && v.value !== null) return `=${v.value}`;
  return `[${v.min ?? "-"},${v.max ?? "-"}]≈`;
}

/**
 * 区间重叠判定。
 * 两个区间只要有交集就算方向一致 —— 严格相等太苛刻，
 * "36~47" vs "36~48" 在业务上是同一个判断结果。
 */
function rangesOverlap(a: ApproxNumber, b: ApproxNumber): boolean {
  const aMin = a.min ?? Number.NEGATIVE_INFINITY;
  const aMax = a.max ?? Number.POSITIVE_INFINITY;
  const bMin = b.min ?? Number.NEGATIVE_INFINITY;
  const bMax = b.max ?? Number.POSITIVE_INFINITY;
  return aMin <= bMax && bMin <= aMax;
}

export function scoreApproxField(
  field: string,
  gold: ApproxNumber | null,
  pred: ApproxNumber | null
): FieldScore {
  const base = {
    field,
    hard: HARD_FIELDS.has(field),
    goldRepr: reprApprox(gold),
    predRepr: reprApprox(pred),
  };

  if (gold === null && pred === null) return { ...base, kind: "correct" };
  if (gold === null) return { ...base, kind: "hallucination" };
  if (pred === null) return { ...base, kind: "miss" };

  const goldExact = !gold.isApproximate && gold.value !== null;
  const predExact = !pred.isApproximate && pred.value !== null;

  if (goldExact && predExact) {
    return {
      ...base,
      kind: gold.value === pred.value ? "correct" : "wrong_value",
    };
  }

  // gold 精确，模型给区间：只要区间盖住真值就算过度保守，否则是错值
  if (goldExact && !predExact) {
    const lo = pred.min ?? Number.NEGATIVE_INFINITY;
    const hi = pred.max ?? Number.POSITIVE_INFINITY;
    const covered = gold.value! >= lo && gold.value! <= hi;
    return { ...base, kind: covered ? "over_hedged" : "wrong_value" };
  }

  // gold 模糊，模型给精确值：这就是 8/26 实测到的「三年多→40」
  if (!goldExact && predExact) {
    return { ...base, kind: "over_precise" };
  }

  // 双方都是区间
  return { ...base, kind: rangesOverlap(gold, pred) ? "correct" : "wrong_value" };
}

export function scoreTriStateField(
  field: string,
  gold: unknown,
  pred: unknown
): FieldScore {
  const base = {
    field,
    hard: HARD_FIELDS.has(field),
    goldRepr: String(gold),
    predRepr: String(pred),
  };
  if (gold === null && pred === null) return { ...base, kind: "correct" };
  if (gold === null) return { ...base, kind: "hallucination" };
  if (pred === null) return { ...base, kind: "miss" };
  return { ...base, kind: gold === pred ? "correct" : "wrong_value" };
}

/** 一条样本的完整评分 */
export function scoreSample(
  gold: ExtractionResult,
  pred: ExtractionResult
): FieldScore[] {
  const out: FieldScore[] = [];

  for (const f of NUMERIC_FIELDS) {
    out.push(
      scoreApproxField(
        f,
        gold[f] as ApproxNumber | null,
        pred[f] as ApproxNumber | null
      )
    );
  }
  for (const f of BOOLEAN_FIELDS) {
    out.push(scoreTriStateField(f, gold[f], pred[f]));
  }
  for (const f of ["incomeBasis", "age", "city", "companyType"] as const) {
    out.push(scoreTriStateField(f, gold[f], pred[f]));
  }

  return out;
}

export type Aggregate = {
  total: number;
  byKind: Record<ErrorKind, number>;
  /** 全部字段准确率 */
  accuracy: number;
  /** 硬阈值字段准确率 —— 业务上真正要看的数 */
  hardAccuracy: number;
  /** 幻觉率：最贵的错误 */
  hallucinationRate: number;
  /** 过度精确率：8/26 发现的缺陷，专项跟踪 */
  overPreciseRate: number;
  /** 逐字段明细，用来定位是哪个字段拖后腿 */
  byField: Record<
    string,
    { total: number; correct: number; accuracy: number; kinds: Partial<Record<ErrorKind, number>> }
  >;
};

const ZERO_KINDS: Record<ErrorKind, number> = {
  correct: 0,
  hallucination: 0,
  miss: 0,
  over_precise: 0,
  over_hedged: 0,
  wrong_value: 0,
};

export function aggregate(scores: FieldScore[]): Aggregate {
  const byKind = { ...ZERO_KINDS };
  const byField: Aggregate["byField"] = {};
  let hardTotal = 0;
  let hardCorrect = 0;

  for (const s of scores) {
    byKind[s.kind] += 1;

    const slot =
      byField[s.field] ??
      (byField[s.field] = { total: 0, correct: 0, accuracy: 0, kinds: {} });
    slot.total += 1;
    slot.kinds[s.kind] = (slot.kinds[s.kind] ?? 0) + 1;
    if (s.kind === "correct") slot.correct += 1;

    if (s.hard) {
      hardTotal += 1;
      if (s.kind === "correct") hardCorrect += 1;
    }
  }

  for (const k of Object.keys(byField)) {
    const s = byField[k];
    s.accuracy = s.total ? s.correct / s.total : 0;
  }

  const total = scores.length;
  return {
    total,
    byKind,
    accuracy: total ? byKind.correct / total : 0,
    hardAccuracy: hardTotal ? hardCorrect / hardTotal : 0,
    hallucinationRate: total ? byKind.hallucination / total : 0,
    overPreciseRate: total ? byKind.over_precise / total : 0,
    byField,
  };
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
