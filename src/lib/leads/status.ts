/**
 * 线索状态机。
 *
 * 八个状态不是拍脑袋定的，对应贷款撮合的真实流程：
 *   new 刚进来 → contacted 联系上了 → qualifying 在问资质 →
 *   matched 匹配到产品/机构 → pushed 已报备给机构 → funded 成交放款
 * 两个终态外的旁路：
 *   lost 明确不做了 / nurture 当前不符合但养一段时间能过
 *
 * ⚠️ **被拒线索不是垃圾，是资产。**（2026-08-26 定的原则）
 * 征信查询次数会随时间衰减、社保月数会自然增长 —— 今天不过的人
 * 三到六个月后可能就过了。所以没有"已流失"这个丢弃动作，
 * 只有 lost（真的不做）和 nurture（排队重捞）。
 * nurture 必须带 nurtureUntil，否则等于扔掉。
 */

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualifying",
  "matched",
  "pushed",
  "funded",
  "lost",
  "nurture",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type StatusMeta = {
  key: LeadStatus;
  label: string;
  /** 列表徽章配色。Tailwind 类名写全，不做字符串拼接（Tailwind 扫不到动态类名） */
  badge: string;
  /** 是否算"在跟进中"，用于顶部统计 */
  active: boolean;
  hint: string;
};

export const STATUS_META: Record<LeadStatus, StatusMeta> = {
  new: {
    key: "new",
    label: "待联系",
    badge: "bg-blue-100 text-blue-800 ring-blue-200",
    active: true,
    hint: "刚进来，还没打过电话",
  },
  contacted: {
    key: "contacted",
    label: "已联系",
    badge: "bg-sky-100 text-sky-800 ring-sky-200",
    active: true,
    hint: "联系上了，还没问完资质",
  },
  qualifying: {
    key: "qualifying",
    label: "问资质中",
    badge: "bg-amber-100 text-amber-800 ring-amber-200",
    active: true,
    hint: "正在收集收入/社保/征信信息",
  },
  matched: {
    key: "matched",
    label: "已匹配",
    badge: "bg-violet-100 text-violet-800 ring-violet-200",
    active: true,
    hint: "已选定产品和机构，未报备",
  },
  pushed: {
    key: "pushed",
    label: "已报备",
    badge: "bg-indigo-100 text-indigo-800 ring-indigo-200",
    active: true,
    hint: "已报给机构，等结果。注意保护期",
  },
  funded: {
    key: "funded",
    label: "已成交",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    active: false,
    hint: "已放款，该收返佣了",
  },
  nurture: {
    key: "nurture",
    label: "养客中",
    badge: "bg-teal-100 text-teal-800 ring-teal-200",
    active: false,
    hint: "当前不符合，到期后重捞。必须填重捞时间",
  },
  lost: {
    key: "lost",
    label: "已流失",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
    active: false,
    hint: "明确不做了。养一养能过的请用「养客中」",
  },
};

export const PRODUCT_LABELS: Record<string, string> = {
  credit: "信用贷",
  mortgage: "房抵贷",
  car: "车抵贷",
  business: "经营贷",
  unknown: "待确认",
};

export const SOURCE_LABELS: Record<string, string> = {
  website: "官网",
  xhs: "小红书",
  wechat: "微信",
  douyin: "抖音",
  referral: "转介绍",
  manual: "手工录入",
};

/** 金额显示成「30万」而不是 300000 —— 车上扫一眼要能看懂 */
export function formatAmount(cents: number | null): string {
  if (cents === null) return "—";
  if (cents >= 10000) {
    const w = cents / 10000;
    return `${Number.isInteger(w) ? w : w.toFixed(1)}万`;
  }
  return `${cents}元`;
}

/** 相对时间。「3天前」比「2026-08-25 14:32」更快判断优先级 */
export function relativeTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day}天前`;
  return `${Math.floor(day / 30)}个月前`;
}
