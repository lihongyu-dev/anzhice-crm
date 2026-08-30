import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  extractionRuns,
  interactions,
  leads,
  qualifications,
} from "@/db/schema";
import { hashInput } from "@/lib/crypto";
import { runExtraction, type ExtractOutcome } from "./run";
import { conservativeValue, type ExtractionResult } from "./types";

/**
 * 抽取管线的落库层 —— 把 runExtraction 接进业务流程。
 *
 * 在这一层出现之前，runExtraction 只被 scripts/run-eval.ts 调用：
 * 管线测得出 99.7% 准确率，却没有任何入口能把一段真实客户对话喂进去。
 * M1 有能力、M5 有壳，中间缺的就是这个文件。
 *
 * ## 三条设计决定
 *
 * ① **抽取结果落 qualifications，但 verifiedFields 一律为空。**
 *    模型输出不是"资质"，是"待核对的资质草稿"。
 *    match/queries.ts 靠 verifiedFields 是否为空来区分 verified / extracted，
 *    UI 据此显示"AI 抽取，未人工确认"。这条链不能在这里被绕过 ——
 *    否则规则引擎会拿模型的猜测当客户的陈述用。
 *
 * ② **每次抽取新插一行 qualifications，不 update 旧行。**
 *    资质是随对话演进的：第一通电话说"社保两年"，第三通说"其实断过"。
 *    覆盖写会把这个演进过程抹掉，而它恰恰是判断可信度的依据。
 *    getLeadMatch 取 updatedAt 最新的一行，天然拿到最新资质。
 *
 * ③ **抽取失败也要留 extraction_runs 记录。**（FR-1.7）
 *    api_error / timeout / schema_invalid 是三种完全不同的问题，
 *    修法分别是重试 / 改 prompt / 加校验。合并成"失败"等于丢掉诊断信息。
 *    失败时不写 qualifications —— 没有数据比有假数据安全。
 */

export type ExtractForLeadResult =
  | {
      ok: true;
      /** 命中去重，未调用模型（FR-1.8 同一输入不重复计费） */
      reused: boolean;
      interactionId: number;
      extractionRunId: number;
      qualificationId: number;
      status: ExtractOutcome["status"];
      data: ExtractionResult;
      violations: ExtractOutcome["violations"];
      reviewFields: string[];
      latencyMs: number;
      costCny: string | null;
      model: string;
      promptVersion: string;
    }
  | {
      ok: false;
      code: "lead_not_found" | "extract_failed";
      /** 失败也有 interaction 与 run 记录，供排查 */
      interactionId: number | null;
      extractionRunId: number | null;
      status: ExtractOutcome["status"];
      message: string;
    };

/**
 * 一段对话原文 → 结构化资质草稿。
 *
 * 去重口径是 (leadId, rawHash)，不是全局 rawHash。
 * 同一段模板话术可能在不同客户身上都出现（"您好，需要多少额度？"），
 * 全局去重会让第二个客户的对话被误判为重复而拿不到资质。
 */
export async function extractForLead(opts: {
  leadId: number;
  rawText: string;
  channel?: string;
  direction?: string;
  occurredAt?: Date;
  model?: string;
}): Promise<ExtractForLeadResult> {
  const { leadId, rawText } = opts;

  const [lead] = await db
    .select({ id: leads.id, amountIntent: leads.amountIntent, city: leads.city })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead) {
    return {
      ok: false,
      code: "lead_not_found",
      interactionId: null,
      extractionRunId: null,
      status: "api_error",
      message: "线索不存在",
    };
  }

  const rawHash = hashInput(rawText);

  /**
   * FR-1.8：同一输入不重复计费。
   *
   * 命中已有 interaction 时，连带找它最新一次成功的 run 与 qualification 直接返回。
   * 找不到成功记录（上次抽取失败过）则继续往下真跑一次 —— 去重针对的是
   * "重复花钱"，不是"重复尝试"。上次失败这次该重试。
   */
  const [dupe] = await db
    .select({ id: interactions.id })
    .from(interactions)
    .where(and(eq(interactions.leadId, leadId), eq(interactions.rawHash, rawHash)))
    .orderBy(desc(interactions.id))
    .limit(1);

  if (dupe) {
    const [prevRun] = await db
      .select({
        id: extractionRuns.id,
        status: extractionRuns.status,
        parsed: extractionRuns.parsed,
        violations: extractionRuns.violations,
        model: extractionRuns.model,
        promptVersion: extractionRuns.promptVersion,
        latencyMs: extractionRuns.latencyMs,
        costUsd: extractionRuns.costUsd,
      })
      .from(extractionRuns)
      .where(eq(extractionRuns.interactionId, dupe.id))
      .orderBy(desc(extractionRuns.id))
      .limit(1);

    const [prevQual] = await db
      .select({ id: qualifications.id, reviewFields: qualifications.reviewFields })
      .from(qualifications)
      .where(eq(qualifications.interactionId, dupe.id))
      .orderBy(desc(qualifications.id))
      .limit(1);

    if (
      prevRun &&
      prevQual &&
      (prevRun.status === "ok" || prevRun.status === "degraded")
    ) {
      return {
        ok: true,
        reused: true,
        interactionId: dupe.id,
        extractionRunId: prevRun.id,
        qualificationId: prevQual.id,
        status: prevRun.status as ExtractOutcome["status"],
        data: prevRun.parsed as ExtractionResult,
        violations: [],
        reviewFields: prevQual.reviewFields ?? [],
        latencyMs: prevRun.latencyMs ?? 0,
        costCny: prevRun.costUsd,
        model: prevRun.model,
        promptVersion: prevRun.promptVersion,
      };
    }
  }

  const [interaction] = dupe
    ? [{ id: dupe.id }]
    : await db
        .insert(interactions)
        .values({
          leadId,
          rawText,
          rawHash,
          channel: opts.channel ?? "wechat",
          direction: opts.direction ?? "inbound",
          occurredAt: opts.occurredAt ?? new Date(),
        })
        .returning({ id: interactions.id });

  const out = await runExtraction(rawText, opts.model);

  const [run] = await db
    .insert(extractionRuns)
    .values({
      interactionId: interaction.id,
      inputHash: out.inputHash,
      provider: "bailian",
      model: out.model,
      promptVersion: out.promptVersion,
      status: out.status,
      rawResponse: out.raw,
      parsed: out.data ?? null,
      violations: out.violations.map((v) => `${v.field}:${v.kind}:${v.detail}`),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
      costUsd: out.costCny,
      latencyMs: out.latencyMs,
    })
    .returning({ id: extractionRuns.id });

  if (!out.data) {
    return {
      ok: false,
      code: "extract_failed",
      interactionId: interaction.id,
      extractionRunId: run.id,
      status: out.status,
      message:
        out.error ??
        {
          api_error: "模型接口调用失败，可重试",
          timeout: "模型响应超时，可重试",
          parse_error: "模型返回的不是合法 JSON",
          schema_invalid: "模型返回结构不符合约定",
          ok: "",
          degraded: "",
        }[out.status],
    };
  }

  const d = out.data;

  const [qual] = await db
    .insert(qualifications)
    .values({
      leadId,
      interactionId: interaction.id,
      extractionRunId: run.id,

      monthlyIncome: d.monthlyIncome,
      incomeBasis: d.incomeBasis,
      socialSecurityMonths: d.socialSecurityMonths,
      providentFundMonths: d.providentFundMonths,
      creditInquiries3m: d.creditInquiries3m,
      debtMonthly: d.debtMonthly,
      businessMonths: d.businessMonths,

      creditOverdue: d.creditOverdue,
      hasMortgage: d.hasMortgage,
      hasCarLoan: d.hasCarLoan,
      hasProvidentFund: d.hasProvidentFund,

      age: d.age,
      companyType: d.companyType,

      /** ← 关键：模型输出永不算已确认 */
      verifiedFields: [],
      reviewFields: out.reviewFields,
    })
    .returning({ id: qualifications.id });

  await db.insert(auditLog).values({
    actor: "admin",
    action: "extract",
    entity: "qualifications",
    entityId: qual.id,
    before: null,
    after: {
      leadId,
      interactionId: interaction.id,
      extractionRunId: run.id,
      model: out.model,
      promptVersion: out.promptVersion,
      status: out.status,
      reviewFields: out.reviewFields,
      violationCount: out.violations.length,
    },
  });

  return {
    ok: true,
    reused: false,
    interactionId: interaction.id,
    extractionRunId: run.id,
    qualificationId: qual.id,
    status: out.status,
    data: d,
    violations: out.violations,
    reviewFields: out.reviewFields,
    latencyMs: out.latencyMs,
    costCny: out.costCny,
    model: out.model,
    promptVersion: out.promptVersion,
  };
}

/**
 * 人工复核落库（FR-1.6）。
 *
 * ## verifiedFields 是这个系统里唯一"可信"的凭证
 *
 * 规则引擎的判定质量完全取决于输入质量。让人工确认过的字段和模型猜的
 * 混在一起，等于让 99.7% 的准确率变成一句无意义的话 ——
 * 剩下 0.3% 落在哪个字段上，只有人看过才知道。
 *
 * 所以：**复核不是可选的润色步骤，是资质从"草稿"变成"依据"的唯一通道。**
 *
 * ## 为什么改值也要留痕
 *
 * 人工把 40 改成 null，这个动作本身就是一条 eval 信号：
 * 说明模型在这条样本上错了。审计日志里的 before/after 是免费的错误样本来源，
 * 将来可以直接筛出来补进标注集（origin='real'）。
 */
export async function saveQualificationReview(opts: {
  qualificationId: number;
  /** 人工修正后的字段值。只传要改的，未传的保持原值 */
  patch: Partial<ExtractionResult>;
  /** 本次确认的字段名。与已有的合并去重 */
  verifiedFields: string[];
}): Promise<
  | { ok: true; qualificationId: number; verifiedFields: string[]; reviewFields: string[] }
  | { ok: false; code: "not_found"; message: string }
> {
  const [before] = await db
    .select()
    .from(qualifications)
    .where(eq(qualifications.id, opts.qualificationId))
    .limit(1);

  if (!before) {
    return { ok: false, code: "not_found", message: "资质记录不存在" };
  }

  const p = opts.patch;
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if ("monthlyIncome" in p) patch.monthlyIncome = p.monthlyIncome ?? null;
  if ("incomeBasis" in p) patch.incomeBasis = p.incomeBasis ?? null;
  if ("socialSecurityMonths" in p)
    patch.socialSecurityMonths = p.socialSecurityMonths ?? null;
  if ("providentFundMonths" in p)
    patch.providentFundMonths = p.providentFundMonths ?? null;
  if ("creditInquiries3m" in p) patch.creditInquiries3m = p.creditInquiries3m ?? null;
  if ("debtMonthly" in p) patch.debtMonthly = p.debtMonthly ?? null;
  if ("businessMonths" in p) patch.businessMonths = p.businessMonths ?? null;
  if ("creditOverdue" in p) patch.creditOverdue = p.creditOverdue ?? null;
  if ("hasMortgage" in p) patch.hasMortgage = p.hasMortgage ?? null;
  if ("hasCarLoan" in p) patch.hasCarLoan = p.hasCarLoan ?? null;
  if ("hasProvidentFund" in p) patch.hasProvidentFund = p.hasProvidentFund ?? null;
  if ("age" in p) patch.age = p.age ?? null;
  if ("companyType" in p) patch.companyType = p.companyType ?? null;

  const verified = [
    ...new Set([...(before.verifiedFields ?? []), ...opts.verifiedFields]),
  ];
  patch.verifiedFields = verified;

  /**
   * 已确认的字段从待复核清单里移除。
   * 人看过并确认了，needsReview 就该消失 —— 否则 UI 上那条橙色警告
   * 会永久挂着，几次之后就被无视，警告也就失去意义。
   */
  patch.reviewFields = (before.reviewFields ?? []).filter(
    (f) => !verified.includes(f)
  );

  const [after] = await db
    .update(qualifications)
    .set(patch)
    .where(eq(qualifications.id, opts.qualificationId))
    .returning({
      id: qualifications.id,
      verifiedFields: qualifications.verifiedFields,
      reviewFields: qualifications.reviewFields,
    });

  /**
   * amountIntent 与 city 不在 qualifications 上（它们是线索属性，不是资质属性），
   * 但抽取会产出。人工确认后同步回 leads —— 否则规则引擎读不到，
   * 客户明明说了"想借三十万"却仍显示意向金额缺失。
   */
  const leadPatch: Record<string, unknown> = {};
  if (opts.verifiedFields.includes("amountIntent") && p.amountIntent !== undefined) {
    const v = conservativeValue(p.amountIntent ?? null);
    if (v !== null) leadPatch.amountIntent = Math.round(v);
  }
  if (opts.verifiedFields.includes("city") && typeof p.city === "string" && p.city) {
    leadPatch.city = p.city;
  }
  if (Object.keys(leadPatch).length > 0) {
    leadPatch.updatedAt = new Date();
    await db.update(leads).set(leadPatch).where(eq(leads.id, before.leadId));
  }

  /** 只记真正变化的字段，避免审计日志被全字段快照冲成噪音 */
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(patch)) {
    if (k === "updatedAt" || k === "verifiedFields" || k === "reviewFields") continue;
    const bv = (before as Record<string, unknown>)[k];
    const av = patch[k];
    if (JSON.stringify(bv) !== JSON.stringify(av)) changed[k] = { from: bv, to: av };
  }

  await db.insert(auditLog).values({
    actor: "admin",
    action: "review_qualification",
    entity: "qualifications",
    entityId: opts.qualificationId,
    before: {
      verifiedFields: before.verifiedFields ?? [],
      reviewFields: before.reviewFields ?? [],
    },
    after: {
      verifiedFields: after.verifiedFields ?? [],
      reviewFields: after.reviewFields ?? [],
      /** 人工改了哪些值 —— 这就是免费的真实错误样本 */
      corrections: changed,
      leadFieldsSynced: Object.keys(leadPatch).filter((k) => k !== "updatedAt"),
    },
  });

  return {
    ok: true,
    qualificationId: after.id,
    verifiedFields: after.verifiedFields ?? [],
    reviewFields: after.reviewFields ?? [],
  };
}

/** 取线索最新的资质草稿，供复核界面回显 */
export async function getLatestQualification(leadId: number) {
  const [row] = await db
    .select()
    .from(qualifications)
    .where(eq(qualifications.leadId, leadId))
    .orderBy(desc(qualifications.updatedAt))
    .limit(1);
  return row ?? null;
}
