/**
 * eval 主入口：跑标注集，出报告。
 *
 *   pnpm eval                          # 默认 qwen-plus，跑全集
 *   pnpm eval --model qwen3.7-flash    # 换模型
 *   pnpm eval --limit 5                # 先跑 5 条试水（省 token）
 *   pnpm eval --model a --model b      # 多模型对比
 *   pnpm eval --no-save                # 不写库
 *
 * 设计取舍：
 *
 * 1. **串行调用，不并发。** 并发会撞百炼限流，而限流导致的 api_error
 *    会污染错误率统计 —— 那是我们自己造的失败，不是模型的失败。
 *    24 条样本串行约 1-2 分钟，可接受。
 *
 * 2. **每次调用都落 extraction_runs。** 报告可以重算，API 调用花的钱不能重来。
 *    原始响应留着，将来改了评分逻辑可以离线重跑，不必再花钱。
 *
 * 3. **报告写盘到 eval-reports/**，该目录已在 .gitignore
 *    （报告含对话原文，真实样本进来后就是客户隐私）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, pgClient } from "../src/db";
import { goldLabels, extractionRuns } from "../src/db/schema";
import { runExtraction } from "../src/lib/extract/run";
import { goldAnswerSchema } from "../src/lib/gold/fields";
import { scoreSample, aggregate, pct, type FieldScore } from "../src/lib/eval/score";
import type { ExtractionResult } from "../src/lib/extract/types";

type Args = {
  models: string[];
  limit: number | null;
  setName: string;
  save: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const models: string[] = [];
  let limit: number | null = null;
  let setName = process.env.GOLD_SET ?? "gold_v1";
  let save = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") models.push(argv[++i]);
    else if (a === "--limit") limit = Number(argv[++i]);
    else if (a === "--set") setName = argv[++i];
    else if (a === "--no-save") save = false;
  }
  if (models.length === 0) models.push(process.env.EXTRACT_MODEL ?? "qwen-plus");
  return { models, limit, setName, save };
}

type SampleRow = {
  id: number;
  rawText: string;
  expected: unknown;
  origin: string;
  note: string | null;
};

type ModelReport = {
  model: string;
  promptVersion: string;
  samples: number;
  statusCounts: Record<string, number>;
  scores: FieldScore[];
  latencies: number[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** 每条样本的失败明细，用于定位 */
  failures: {
    id: number;
    probe: string;
    status: string;
    errors: string[];
  }[];
};

async function evalModel(
  model: string,
  rows: SampleRow[],
  save: boolean
): Promise<ModelReport> {
  const report: ModelReport = {
    model,
    promptVersion: "",
    samples: rows.length,
    statusCounts: {},
    scores: [],
    latencies: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    failures: [],
  };

  for (const [i, row] of rows.entries()) {
    const probe = (row.note ?? "").replace(/^\[考点\]\s*/, "");
    process.stdout.write(
      `  [${String(i + 1).padStart(2)}/${rows.length}] #${row.id} ${probe.slice(0, 42)}… `
    );

    const out = await runExtraction(row.rawText, model);
    report.promptVersion = out.promptVersion;
    report.statusCounts[out.status] = (report.statusCounts[out.status] ?? 0) + 1;
    report.latencies.push(out.latencyMs);
    report.totalPromptTokens += out.usage.promptTokens ?? 0;
    report.totalCompletionTokens += out.usage.completionTokens ?? 0;

    if (save) {
      await db.insert(extractionRuns).values({
        interactionId: null,
        inputHash: out.inputHash,
        provider: "bailian",
        model: out.model,
        promptVersion: out.promptVersion,
        status: out.status,
        rawResponse: out.raw,
        parsed: out.data ?? null,
        violations: out.violations.map(
          (v) => `${v.field}:${v.kind}:${v.detail}`
        ),
        promptTokens: out.usage.promptTokens,
        completionTokens: out.usage.completionTokens,
        costUsd: out.costCny,
        latencyMs: out.latencyMs,
      });
    }

    if (!out.data) {
      report.failures.push({
        id: row.id,
        probe,
        status: out.status,
        errors: [out.error ?? "无数据"],
      });
      console.log(`✗ ${out.status}`);
      continue;
    }

    // gold 存的是 jsonb，过一遍 schema 保证结构一致（否则比对会静默错位）
    const goldParsed = goldAnswerSchema.safeParse(row.expected);
    if (!goldParsed.success) {
      report.failures.push({
        id: row.id,
        probe,
        status: "gold_invalid",
        errors: ["标注答案本身不符合 schema，跳过：" +
          goldParsed.error.issues.map((x) => x.path.join(".")).join(",")],
      });
      console.log("✗ gold_invalid");
      continue;
    }

    const scores = scoreSample(
      goldParsed.data as ExtractionResult,
      out.data
    );
    report.scores.push(...scores);

    const bad = scores.filter((s) => s.kind !== "correct");
    if (bad.length > 0) {
      report.failures.push({
        id: row.id,
        probe,
        status: out.status,
        errors: bad.map(
          (b) => `${b.field}[${b.kind}] gold=${b.goldRepr} pred=${b.predRepr}`
        ),
      });
    }
    const hardBad = bad.filter((b) => b.hard).length;
    console.log(
      `${bad.length === 0 ? "✓" : `△ ${bad.length}错(硬${hardBad})`} ${out.latencyMs}ms`
    );
  }

  return report;
}

function renderReport(reports: ModelReport[], rows: SampleRow[]): string {
  const L: string[] = [];
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const originCount = rows.reduce<Record<string, number>>((m, r) => {
    m[r.origin] = (m[r.origin] ?? 0) + 1;
    return m;
  }, {});

  L.push(`# 抽取 eval 报告`);
  L.push(``);
  L.push(`生成时间：${now}`);
  L.push(`样本数：${rows.length}（${Object.entries(originCount)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")}）`);
  L.push(``);
  if ((originCount.real ?? 0) === 0) {
    L.push(
      `> ⚠️ **本轮全部为合成样本（synthetic）。** 合成对话措辞比真人规整，`
    );
    L.push(
      `> 准确率会系统性偏高，不能当作真实场景性能。此集的作用是**回归测试**：`
    );
    L.push(`> 每条样本对应一个已知失效模式，用来验证缺陷有没有被修掉。`);
    L.push(``);
  }

  L.push(`## 总览`);
  L.push(``);
  L.push(
    `| 模型 | prompt | 全字段准确率 | 硬字段准确率 | 幻觉率 | 过度精确率 | 漏抽率 | P50延迟 | tokens |`
  );
  L.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of reports) {
    const agg = aggregate(r.scores);
    const lat = [...r.latencies].sort((a, b) => a - b);
    const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
    const missRate = agg.total ? agg.byKind.miss / agg.total : 0;
    L.push(
      `| ${r.model} | ${r.promptVersion} | ${pct(agg.accuracy)} | **${pct(
        agg.hardAccuracy
      )}** | ${pct(agg.hallucinationRate)} | ${pct(agg.overPreciseRate)} | ${pct(
        missRate
      )} | ${p50}ms | ${r.totalPromptTokens}+${r.totalCompletionTokens} |`
    );
  }
  L.push(``);
  L.push(`**为什么不只报一个准确率**：在贷款资质场景里错误代价不对称。`);
  L.push(`幻觉（客户没说却编出数字）可能导致推错单，中介那边一次就毁信任；`);
  L.push(`漏抽只需人工补一句。混成一个百分比等于把最贵的错误藏起来。`);
  L.push(`硬字段（收入/社保/公积金/征信查询/负债/营业年限）直接决定能不能推单，单独统计。`);
  L.push(``);

  for (const r of reports) {
    const agg = aggregate(r.scores);
    L.push(`## ${r.model}`);
    L.push(``);
    L.push(`调用状态：${Object.entries(r.statusCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`);
    L.push(``);
    L.push(`### 错误类型分布`);
    L.push(``);
    L.push(`| 类型 | 次数 | 占比 | 含义 |`);
    L.push(`|---|---|---|---|`);
    const meaning: Record<string, string> = {
      correct: "正确",
      hallucination: "客户没说，模型编了值 —— 最贵",
      miss: "客户说了，模型漏了 —— 人工可补",
      over_precise: "模糊表达被输出成精确值",
      over_hedged: "精确值被输出成区间（保守，可用）",
      wrong_value: "都有值但不符",
    };
    for (const [k, v] of Object.entries(agg.byKind)) {
      if (v === 0) continue;
      L.push(
        `| ${k} | ${v} | ${pct(agg.total ? v / agg.total : 0)} | ${meaning[k] ?? ""} |`
      );
    }
    L.push(``);

    L.push(`### 逐字段准确率（升序，最差的在前）`);
    L.push(``);
    L.push(`| 字段 | 硬 | 准确率 | 正确/总数 | 主要错误 |`);
    L.push(`|---|---|---|---|---|`);
    const fields = Object.entries(agg.byField).sort(
      (a, b) => a[1].accuracy - b[1].accuracy
    );
    const HARD = new Set([
      "monthlyIncome",
      "socialSecurityMonths",
      "providentFundMonths",
      "creditInquiries3m",
      "debtMonthly",
      "businessMonths",
    ]);
    for (const [f, s] of fields) {
      const kinds = Object.entries(s.kinds)
        .filter(([k]) => k !== "correct")
        .map(([k, v]) => `${k}×${v}`)
        .join(" ");
      L.push(
        `| ${f} | ${HARD.has(f) ? "✔" : ""} | ${pct(s.accuracy)} | ${s.correct}/${s.total} | ${kinds || "-"} |`
      );
    }
    L.push(``);

    if (r.failures.length > 0) {
      L.push(`### 失败明细`);
      L.push(``);
      for (const f of r.failures) {
        L.push(`**#${f.id}** ${f.probe}`);
        L.push(``);
        for (const e of f.errors) L.push(`- ${e}`);
        L.push(``);
      }
    }
  }

  return L.join("\n");
}

async function main() {
  const args = parseArgs();

  let rows = (await db
    .select({
      id: goldLabels.id,
      rawText: goldLabels.rawText,
      expected: goldLabels.expected,
      origin: goldLabels.origin,
      note: goldLabels.note,
    })
    .from(goldLabels)
    .where(eq(goldLabels.setName, args.setName))) as SampleRow[];

  if (rows.length === 0) {
    console.error(
      `标注集 ${args.setName} 为空。先跑 pnpm gold:seed 灌合成样本，或在 /app/label 手工标注。`
    );
    process.exitCode = 1;
    return;
  }
  rows.sort((a, b) => a.id - b.id);
  if (args.limit) rows = rows.slice(0, args.limit);

  console.log(
    `标注集 ${args.setName}：${rows.length} 条 | 模型：${args.models.join(", ")} | 写库：${args.save ? "是" : "否"}\n`
  );

  const reports: ModelReport[] = [];
  for (const m of args.models) {
    console.log(`── ${m} ──`);
    reports.push(await evalModel(m, rows, args.save));
    console.log("");
  }

  const md = renderReport(reports, rows);
  mkdirSync("eval-reports", { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const file = `eval-reports/eval-${stamp}.md`;
  writeFileSync(file, md + "\n", "utf8");

  // 控制台只打总览表，明细看文件
  console.log(md.split("## " + reports[0].model)[0]);
  console.log(`完整报告：${file}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
