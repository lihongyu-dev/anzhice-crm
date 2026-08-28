import {
  NUMERIC_FIELDS,
  type ApproxNumber,
  type ExtractionResult,
  type NumericField,
} from "./types";

/**
 * 交叉校验层 —— 不相信模型，验证模型。
 *
 * 2026-08-26 实测在 qwen-plus 上发现三类错误，prompt 调不干净，
 * 必须用确定性代码兜底：
 *
 * ① 跨字段污染（最严重）
 *    输入「社保交了两年整」，公积金根本没提，模型给公积金也填了 24。
 *    识别特征：多个字段共用同一段 rawText。
 *
 * ② 精确值被当模糊值
 *    客户说「查了2次征信」是确定数字，模型套用「几次=2到5」规则输出区间。
 *    识别特征：rawText 里含明确数字，却标了 isApproximate。
 *
 * ③ 自相矛盾
 *    标了 isApproximate 却同时给出精确 value；或 min > max。
 *
 * 处理策略：违规字段降级为 needsReview，不直接丢弃 —— 保留信息让人工判断，
 * 但绝不让它参与自动的资质判断。
 */

export type Violation = {
  field: string;
  kind: "cross_contamination" | "false_approximate" | "self_contradiction" | "range_invalid";
  detail: string;
};

export type ValidationOutcome = {
  data: ExtractionResult;
  violations: Violation[];
  reviewFields: string[];
};

/** 从原文里找明确的阿拉伯数字或确定性中文数字 */
const EXPLICIT_NUMBER = /\d/;
const EXACT_WORDS = ["整", "正好", "刚好", "准确"];
/** 模糊限定词。带这些的即使有数字也算模糊，如「三年多」「一万五左右」 */
const FUZZY_WORDS = ["多", "左右", "大概", "大约", "差不多", "将近", "快", "几", "余", "上下", "到"];

function isFuzzyText(raw: string): boolean {
  return FUZZY_WORDS.some((w) => raw.includes(w));
}

function looksExact(raw: string): boolean {
  if (EXACT_WORDS.some((w) => raw.includes(w))) return true;
  return EXPLICIT_NUMBER.test(raw) && !isFuzzyText(raw);
}

function normalizeRaw(raw: string): string {
  return raw.replace(/\s/g, "").trim();
}

/**
 * 主校验入口。返回修正后的数据 + 违规清单。
 * 违规清单要落到 extraction_runs.violations，供 eval 统计。
 */
export function validateExtraction(input: ExtractionResult): ValidationOutcome {
  const data: ExtractionResult = structuredClone(input);
  const violations: Violation[] = [];
  const reviewFields = new Set<string>();

  const flag = (field: string, kind: Violation["kind"], detail: string) => {
    violations.push({ field, kind, detail });
    reviewFields.add(field);
  };

  // ---- ① 跨字段污染：同一段 rawText 出现在多个字段 ----
  const byRaw = new Map<string, NumericField[]>();
  for (const f of NUMERIC_FIELDS) {
    const v = data[f] as ApproxNumber | null;
    if (!v) continue;
    const key = normalizeRaw(v.rawText);
    if (!key) continue;
    const list = byRaw.get(key) ?? [];
    list.push(f);
    byRaw.set(key, list);
  }

  for (const [raw, fields] of byRaw) {
    if (fields.length < 2) continue;
    // 保留第一个（通常是模型最先、也最可能正确的归属），其余全部降级
    const [kept, ...dupes] = fields;
    for (const f of dupes) {
      const v = data[f] as ApproxNumber;
      v.needsReview = true;
      flag(
        f,
        "cross_contamination",
        `与 ${kept} 共用原文「${raw}」，疑似字段串味，已标待复核`
      );
    }
  }

  // ---- ②③ 逐字段自查 ----
  for (const f of NUMERIC_FIELDS) {
    const v = data[f] as ApproxNumber | null;
    if (!v) continue;
    const raw = normalizeRaw(v.rawText);

    // ③ 自相矛盾：标了模糊却给精确值
    if (v.isApproximate && v.value !== null) {
      flag(f, "self_contradiction", `isApproximate=true 但 value=${v.value}，已清空 value`);
      v.value = null;
      v.needsReview = true;
    }

    // ③ 区间非法
    if (v.min !== null && v.max !== null && v.min > v.max) {
      flag(f, "range_invalid", `min(${v.min}) > max(${v.max})，已交换`);
      [v.min, v.max] = [v.max, v.min];
      v.needsReview = true;
    }

    // ③ 模糊却没给区间 = 无法用于判断
    if (v.isApproximate && v.min === null && v.max === null) {
      flag(f, "range_invalid", "标为模糊但未提供区间，无法用于阈值判断");
      v.needsReview = true;
    }

    // ② 原文明确却被当成模糊
    if (v.isApproximate && raw && looksExact(raw)) {
      flag(
        f,
        "false_approximate",
        `原文「${raw}」含明确数值却标为模糊，已标待复核`
      );
      v.needsReview = true;
    }

    // 精确值但缺 value，补齐（min===max 时可安全推断）
    if (!v.isApproximate && v.value === null && v.min !== null && v.min === v.max) {
      v.value = v.min;
    }
  }

  return { data, violations, reviewFields: [...reviewFields] };
}

/** 违规是否严重到不能自动进入资质判断 */
export function hasBlockingViolation(violations: Violation[]): boolean {
  return violations.some(
    (v) => v.kind === "cross_contamination" || v.kind === "range_invalid"
  );
}
