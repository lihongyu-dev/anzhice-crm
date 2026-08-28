import { readFileSync } from "node:fs";

/**
 * 阿里云百炼（DashScope OpenAI 兼容模式）客户端。
 *
 * 设计约束：
 * 1. Key 只从 ~/.openclaw/workspace/.env.bailian 读，chmod 600，不进仓库。
 *    绝不写死在代码里，也不放 .env.local（那个文件里已经有数据库口令，
 *    多一个 key 多一个泄露面）。
 * 2. 直连官方 endpoint。2026-08-26 已明确：真实客户手机号/征信
 *    绝不过来源不明的第三方中转 API。
 * 3. 不做重试封装里的静默降级 —— 失败必须让上层看见，
 *    eval 要统计 api_error 率，静默重试会把真实失败率抹掉。
 */

const BASE_URL =
  process.env.BAILIAN_BASE_URL ??
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

const ENV_PATHS = [
  "/home/ubuntu/.openclaw/workspace/.env.bailian",
  ".env.bailian",
];

let cachedKey: string | null = null;

export function getBailianKey(): string {
  if (cachedKey) return cachedKey;
  if (process.env.BAILIAN_API_KEY) {
    cachedKey = process.env.BAILIAN_API_KEY.trim();
    return cachedKey;
  }
  for (const p of ENV_PATHS) {
    try {
      const line = readFileSync(p, "utf8")
        .split("\n")
        .find((l) => l.startsWith("BAILIAN_API_KEY="));
      if (line) {
        cachedKey = line.slice("BAILIAN_API_KEY=".length).trim();
        if (cachedKey) return cachedKey;
      }
    } catch {
      /* 换下一个路径 */
    }
  }
  throw new Error(
    "BAILIAN_API_KEY 未找到。检查 ~/.openclaw/workspace/.env.bailian"
  );
}

export type ChatUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
};

export type ChatResult = {
  ok: boolean;
  /** ok | api_error | timeout */
  status: "ok" | "api_error" | "timeout";
  content: string | null;
  usage: ChatUsage;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
};

export type ChatOptions = {
  model: string;
  system: string;
  user: string;
  /** 抽取任务要确定性，默认 0 */
  temperature?: number;
  timeoutMs?: number;
  /** 要求返回 JSON 对象。部分 qwen 模型支持 response_format */
  jsonMode?: boolean;
};

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const {
    model,
    system,
    user,
    temperature = 0,
    timeoutMs = 60_000,
    jsonMode = true,
  } = opts;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body: Record<string, unknown> = {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getBailianKey()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        status: "api_error",
        content: null,
        usage: { promptTokens: null, completionTokens: null },
        latencyMs,
        httpStatus: res.status,
        // 截断：错误体可能很长，且可能回显输入内容（含客户信息）
        error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }

    const json = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      ok: true,
      status: "ok",
      content: json.choices?.[0]?.message?.content ?? null,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? null,
        completionTokens: json.usage?.completion_tokens ?? null,
      },
      latencyMs,
      httpStatus: res.status,
      error: null,
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: aborted ? "timeout" : "api_error",
      content: null,
      usage: { promptTokens: null, completionTokens: null },
      latencyMs,
      httpStatus: null,
      error: aborted ? `超时 ${timeoutMs}ms` : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 成本估算。
 *
 * 故意不内置价格表 —— 百炼价格会变，写死的数字会在某天悄悄变成错的，
 * 而错的成本数字比没有成本数字更糟（会误导模型选型决策）。
 * 需要成本时通过环境变量显式提供，来源是控制台实际计费页。
 *   BAILIAN_PRICE_IN_PER_1K / BAILIAN_PRICE_OUT_PER_1K（单位：元）
 */
export function estimateCostCny(usage: ChatUsage): string | null {
  const inRate = Number(process.env.BAILIAN_PRICE_IN_PER_1K);
  const outRate = Number(process.env.BAILIAN_PRICE_OUT_PER_1K);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return null;
  if (usage.promptTokens === null || usage.completionTokens === null) return null;
  const cost =
    (usage.promptTokens / 1000) * inRate +
    (usage.completionTokens / 1000) * outRate;
  return cost.toFixed(6);
}
