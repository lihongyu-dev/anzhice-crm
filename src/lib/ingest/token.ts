import { timingSafeEqual } from "node:crypto";

/**
 * 入库通道的令牌校验。
 *
 * 为什么不复用会话认证（SESSION_SECRET + cookie）：
 * 门户站是机器对机器调用，没有浏览器、没有 cookie、也不该有登录态。
 * 给它一张**只能写入**的独立令牌，能力范围就锁死在"投递一条线索"。
 *
 * 威胁模型（这是选 B 方案的全部理由）：
 * 门户站在公网、是主要暴露面。一旦被拿下，攻击者拿到的只有这张写入令牌 ——
 * 读不到任何存量线索，拉不走客户手机号库。
 * 如果当初让门户站直连 Postgres（A 方案），泄露的就是整个数据库凭据。
 *
 * fail closed：INGEST_TOKEN 未配置时拒绝所有请求。
 * 配置缺失最常见于部署漏环境变量，那一刻恰恰最不能放行。
 */

export function verifyIngestToken(req: Request): boolean {
  const expected = process.env.INGEST_TOKEN?.trim();
  if (!expected) return false;

  // 只从请求头取，不支持查询串 —— 查询串会进 nginx 访问日志，
  // 令牌落盘到日志等于长期泄露。
  const provided = req.headers.get("x-ingest-token")?.trim() ?? "";
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // 长度不等直接返回。这里泄露长度信息可以接受：
  // 令牌是 48 位 hex 随机串，知道长度不降低暴破难度。
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
