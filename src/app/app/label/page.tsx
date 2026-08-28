import { getGoldStats } from "@/lib/gold/queries";
import LabelForm from "./label-form";

/**
 * 标注页（服务端组件）。
 *
 * 统计数在服务端取，不在客户端 effect 里拉 —— 少一次往返，
 * 也避免 setState-in-effect 造成的级联渲染。
 * 保存成功后由客户端调 router.refresh() 重新执行本组件刷新统计。
 *
 * ⚠️ 盲标纪律（标注规范 6.1）：本页及其数据源不含任何模型输出。
 */

const SET_NAME = "gold_v1";

export const dynamic = "force-dynamic";

export default async function LabelPage() {
  const stats = await getGoldStats(SET_NAME);
  return <LabelForm setName={SET_NAME} stats={stats} />;
}
