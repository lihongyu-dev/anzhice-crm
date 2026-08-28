import { extractionSchema, type ExtractionResult } from "./types";
import { validateExtraction, type Violation } from "./validate";
import { SYSTEM_PROMPT, buildUserPrompt, PROMPT_VERSION } from "./prompt";
import { chat, estimateCostCny, type ChatUsage } from "../llm/bailian";
import { hashInput } from "../crypto";

/**
 * 单条抽取的完整管线：
 *   prompt → 模型 → 解析 JSON → zod 校验 → 交叉校验 → 结果
 *
 * 每一层失败都有独立 status，不合并成一个笼统的"失败"：
 * eval 报告要能区分「模型没返回」和「返回了但结构不对」和「结构对但内容矛盾」，
 * 这三种问题的修法完全不同（重试 / 改 prompt / 加校验规则）。
 */

export type ExtractStatus =
  | "ok"
  | "degraded"
  | "schema_invalid"
  | "parse_error"
  | "api_error"
  | "timeout";

export type ExtractOutcome = {
  status: ExtractStatus;
  data: ExtractionResult | null;
  violations: Violation[];
  reviewFields: string[];
  raw: string | null;
  model: string;
  promptVersion: string;
  inputHash: string;
  usage: ChatUsage;
  costCny: string | null;
  latencyMs: number;
  error: string | null;
};

/** 模型有时会包一层 ```json 代码块，即使要求了 json_object */
function stripFence(s: string): string {
  const t = s.trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

export async function runExtraction(
  rawText: string,
  model = process.env.EXTRACT_MODEL ?? "qwen-plus"
): Promise<ExtractOutcome> {
  const inputHash = hashInput(rawText);
  const base = {
    model,
    promptVersion: PROMPT_VERSION,
    inputHash,
    violations: [] as Violation[],
    reviewFields: [] as string[],
    data: null,
    costCny: null,
  };

  const res = await chat({
    model,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(rawText),
  });

  if (!res.ok || res.content === null) {
    return {
      ...base,
      status: res.status === "timeout" ? "timeout" : "api_error",
      raw: null,
      usage: res.usage,
      latencyMs: res.latencyMs,
      error: res.error ?? "模型无返回内容",
    };
  }

  const costCny = estimateCostCny(res.usage);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripFence(res.content));
  } catch (e) {
    return {
      ...base,
      status: "parse_error",
      raw: res.content,
      usage: res.usage,
      costCny,
      latencyMs: res.latencyMs,
      error: `JSON 解析失败: ${String(e).slice(0, 200)}`,
    };
  }

  const zres = extractionSchema.safeParse(parsedJson);
  if (!zres.success) {
    return {
      ...base,
      status: "schema_invalid",
      raw: res.content,
      usage: res.usage,
      costCny,
      latencyMs: res.latencyMs,
      error: zres.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }

  const { data, violations, reviewFields } = validateExtraction(zres.data);

  return {
    status: violations.length > 0 ? "degraded" : "ok",
    data,
    violations,
    reviewFields,
    raw: res.content,
    model,
    promptVersion: PROMPT_VERSION,
    inputHash,
    usage: res.usage,
    costCny,
    latencyMs: res.latencyMs,
    error: null,
  };
}
