/**
 * 把合成样本灌进 gold_labels。
 *
 * 幂等：按 rawText 去重，已存在的跳过。可以反复跑。
 *
 * --reset 会先删掉本集合内 origin='synthetic' 的行再重灌。
 * 只删合成样本 —— 它们由 samples.ts 生成，删了能原样重建，零人工损失。
 * origin='real' 的手工标注**永不触碰**，那是成本最高的资产。
 *
 * 用法：
 *   pnpm gold:seed
 *   pnpm gold:seed --reset     # 样本定义改过之后用这个
 */
import { and, eq, sql } from "drizzle-orm";
import { db, pgClient } from "../src/db";
import { goldLabels } from "../src/db/schema";
import { goldLabelInputSchema } from "../src/lib/gold/fields";
import { SYNTHETIC_SAMPLES } from "../src/lib/eval/samples";

const SET_NAME = process.env.GOLD_SET ?? "gold_v1";
const RESET = process.argv.includes("--reset");

async function main() {
  if (RESET) {
    const deleted = await db
      .delete(goldLabels)
      .where(
        and(eq(goldLabels.setName, SET_NAME), eq(goldLabels.origin, "synthetic"))
      )
      .returning({ id: goldLabels.id });
    console.log(
      `--reset：已删除 ${deleted.length} 条合成样本（origin='real' 未触碰）`
    );
  }

  const existing = await db
    .select({ rawText: goldLabels.rawText })
    .from(goldLabels)
    .where(eq(goldLabels.setName, SET_NAME));
  const seen = new Set(existing.map((r) => r.rawText.trim()));

  let inserted = 0;
  let skipped = 0;
  let invalid = 0;

  for (const s of SYNTHETIC_SAMPLES) {
    const raw = s.rawText.trim();
    if (seen.has(raw)) {
      skipped += 1;
      continue;
    }

    const candidate = {
      setName: SET_NAME,
      rawText: raw,
      expected: s.expected,
      origin: "synthetic" as const,
      note: `[考点] ${s.probe}`,
      hasCorrection: s.hasCorrection ?? false,
      pendingReview: s.pendingReview ?? false,
    };

    const parsed = goldLabelInputSchema.safeParse(candidate);
    if (!parsed.success) {
      invalid += 1;
      console.error(
        `✗ 样本校验失败（${s.probe.slice(0, 30)}）:`,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
      continue;
    }

    await db.insert(goldLabels).values(parsed.data);
    inserted += 1;
    seen.add(raw);
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(goldLabels)
    .where(eq(goldLabels.setName, SET_NAME));
  const count = row?.count ?? 0;

  console.log(
    `\n集合 ${SET_NAME}: 新增 ${inserted}，跳过（已存在）${skipped}，校验失败 ${invalid}，当前总数 ${count}`
  );
  if (invalid > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
