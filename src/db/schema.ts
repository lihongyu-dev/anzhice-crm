import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * 安知策 CRM 数据模型
 *
 * 设计约束（来自 2026-08-26 的抽取实验）：
 * 1. 资质里的数值字段不能是裸 number。模型会把「三年多」编成 40。
 *    所以统一用 ApproxNumber 结构存 jsonb，保留区间和原文。
 * 2. 手机号拆三列：加密存储 / 掩码展示 / 指纹去重。
 * 3. 每条抽取结果都要能追溯到哪次模型调用（extraction_runs）。
 */

/**
 * 模糊数值。客户说「公积金三年多」时：
 *   { value: null, min: 36, max: 47, isApproximate: true, rawText: "三年多" }
 * 客户说「社保两年整」时：
 *   { value: 24, min: 24, max: 24, isApproximate: false, rawText: "两年整" }
 *
 * 硬阈值判断时一律取 min —— 保守方向永远安全。
 */
export type ApproxNumber = {
  value: number | null;
  min: number | null;
  max: number | null;
  isApproximate: boolean;
  rawText: string;
  /** 交叉校验降级时标记，见 lib/extract/validate.ts */
  needsReview?: boolean;
};

/** 线索 */
export const leads = pgTable(
  "leads",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),

    // 手机号三件套
    phoneEnc: text("phone_enc").notNull(), // AES-256-GCM，格式 iv:tag:ciphertext
    phoneMask: text("phone_mask").notNull(), // 138****8000，界面展示
    phoneHash: text("phone_hash").notNull(), // HMAC+pepper，去重与精确查找

    // 来源归因：内容策略要靠这些字段修正，不然就是瞎写
    source: text("source").notNull().default("manual"), // website | xhs | wechat | douyin | referral | manual
    channelDetail: text("channel_detail"), // 具体哪篇文章/哪个视频
    landingPage: text("landing_page"),
    utm: jsonb("utm").$type<Record<string, string>>(),

    productIntent: text("product_intent"), // credit | mortgage | car | business | unknown
    amountIntent: integer("amount_intent"), // 元
    city: text("city").default("北京"),
    rawNote: text("raw_note"), // 原始备注

    status: text("status").notNull().default("new"),
    // new | contacted | qualifying | matched | pushed | funded | lost | nurture
    lostReason: text("lost_reason"),

    /** 被拒线索不是垃圾。养 3-6 个月能过，按这个时间排队重捞 */
    nurtureUntil: timestamp("nurture_until", { withTimezone: true }),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("leads_phone_hash_uniq").on(t.phoneHash),
    index("leads_status_idx").on(t.status),
    index("leads_next_action_idx").on(t.nextActionAt),
    index("leads_source_idx").on(t.source),
  ]
);

/** 沟通记录。抽取的输入源就是这里的 rawText */
export const interactions = pgTable(
  "interactions",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    channel: text("channel").notNull().default("wechat"), // wechat | phone | website | other
    direction: text("direction").notNull().default("inbound"), // inbound | outbound

    /** 手动粘贴的微信聊天记录原文 */
    rawText: text("raw_text").notNull(),
    /** 输入指纹，防重复抽取重复计费 */
    rawHash: text("raw_hash").notNull(),

    summary: text("summary"),
    nextAction: text("next_action"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interactions_lead_idx").on(t.leadId),
    index("interactions_raw_hash_idx").on(t.rawHash),
  ]
);

/** 资质档案。数值字段全部 ApproxNumber */
export const qualifications = pgTable(
  "qualifications",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    interactionId: integer("interaction_id").references(() => interactions.id, {
      onDelete: "set null",
    }),
    extractionRunId: integer("extraction_run_id"),

    monthlyIncome: jsonb("monthly_income").$type<ApproxNumber | null>(),
    /**
     * 月收入口径：pretax | aftertax | unknown。标注规范 v1.0 裁决 4.1-A。
     * 客户说「月薪一万二」时税前税后不明，不换算、不推测，如实记录口径。
     */
    incomeBasis: text("income_basis"),
    socialSecurityMonths: jsonb("social_security_months").$type<ApproxNumber | null>(),
    providentFundMonths: jsonb("provident_fund_months").$type<ApproxNumber | null>(),
    creditInquiries3m: jsonb("credit_inquiries_3m").$type<ApproxNumber | null>(),
    debtMonthly: jsonb("debt_monthly").$type<ApproxNumber | null>(),
    businessMonths: jsonb("business_months").$type<ApproxNumber | null>(),

    // 布尔字段：null 表示对话里没提，不是 false
    creditOverdue: boolean("credit_overdue"),
    hasMortgage: boolean("has_mortgage"),
    /**
     * 语义是「有车贷」，不是「有车」。
     *
     * 2026-08-28 eval 实测：原名 hasCar 导致 qwen-plus 在
     * 「有辆车，全款的，没有车贷」上输出 true —— 字段名本身在误导模型。
     * 抽取层已于当时改名 hasCarLoan，但数据库这一层漏了（仍叫 has_car）。
     *
     * 2026-08-29 补齐：否则一旦写落库代码从 has_car 列读写，
     * 这个已经修好的 bug 会从数据库层回来。
     * 字段名不一致本身就是 bug 温床。
     */
    hasCarLoan: boolean("has_car_loan"),
    hasProvidentFund: boolean("has_provident_fund"),

    age: integer("age"),
    companyType: text("company_type"), // state | private | foreign | self_employed | none
    /**
     * 学历：below_high_school | high_school | college | bachelor | master | doctor
     *
     * 存枚举字符串而不存客户原话：「大专」「大学」「本科」「研究生」
     * 存原文就无法比大小，而信用贷产品的准入条件是「≥ 大专」这种阈值形式。
     * 比大小靠 EDUCATION_RANK（src/lib/extract/types.ts）。
     */
    education: text("education"),

    /** 人工确认过的字段名列表。过了这一关的值才能用于正式判断 */
    verifiedFields: jsonb("verified_fields").$type<string[]>().default([]),
    /** 需人工复核的字段（低置信 / 交叉校验降级） */
    reviewFields: jsonb("review_fields").$type<string[]>().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("qualifications_lead_idx").on(t.leadId)]
);

/** 每次模型调用的完整记录。eval 和成本核算都靠它 */
export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: serial("id").primaryKey(),
    interactionId: integer("interaction_id").references(() => interactions.id, {
      onDelete: "cascade",
    }),
    inputHash: text("input_hash").notNull(),

    provider: text("provider").notNull().default("bailian"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),

    status: text("status").notNull(), // ok | schema_invalid | api_error | timeout | degraded
    rawResponse: text("raw_response"),
    parsed: jsonb("parsed"),
    /** 交叉校验发现的问题：字段串味、模糊值被当精确值等 */
    violations: jsonb("violations").$type<string[]>().default([]),

    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: text("cost_usd"), // 用 text 存，避免浮点误差
    latencyMs: integer("latency_ms"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("extraction_runs_input_hash_idx").on(t.inputHash),
    index("extraction_runs_model_idx").on(t.model),
  ]
);

/** 标注集：eval 的标准答案。这是简历里那个准确率数字的来源 */
export const goldLabels = pgTable(
  "gold_labels",
  {
    id: serial("id").primaryKey(),
    setName: text("set_name").notNull().default("gold_v1"),
    rawText: text("raw_text").notNull(),
    /** 手工标注的正确答案，结构同抽取输出 */
    expected: jsonb("expected").notNull(),
    /** real = 真实客户对话，synthetic = 造的。报告里必须区分披露 */
    origin: text("origin").notNull().default("real"),
    note: text("note"),
    /**
     * 客户中途改口（先说一万后改口一万二）。标注规范 v1.0 裁决 5-A。
     * 单独统计有意义：模型容易抓住第一次陈述而忽略后面的修正。
     */
    hasCorrection: boolean("has_correction").notNull().default(false),
    /** 标注未覆盖的说法，留待补规范。对应规范 6.3 待议清单 */
    pendingReview: boolean("pending_review").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gold_labels_set_idx").on(t.setName)]
);

/** 审计日志。改了什么都要留痕 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    actor: text("actor").notNull().default("admin"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: integer("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("audit_log_entity_idx").on(t.entity, t.entityId)]
);

/**
 * 登录尝试记录 —— 限流的存储层。
 *
 * 为什么用数据库而不是内存 Map：门户站 2026-08-26 那版限流用的是模块级 Map，
 * 而 systemd 配了 Restart=always。进程一重启计数就清零，
 * 攻击者只要打到进程崩溃或等一次部署就能重置额度，等于没有限流。
 * 写库虽然多一次 IO，但重启不丢、可审计、能查历史。
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: serial("id").primaryKey(),
    /** 取自 X-Forwarded-For 首段。nginx 已配置该头 */
    ip: text("ip").notNull(),
    success: boolean("success").notNull().default(false),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_ip_at_idx").on(t.ip, t.at)]
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Interaction = typeof interactions.$inferSelect;
export type Qualification = typeof qualifications.$inferSelect;
export type ExtractionRun = typeof extractionRuns.$inferSelect;
export type GoldLabel = typeof goldLabels.$inferSelect;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
