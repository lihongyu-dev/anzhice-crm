import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * 手机号的三种形态
 *
 * 为什么要三列：
 * - 加密值（phoneEnc）：库被拷走也读不出真实号码。但每次加密的 IV 不同，
 *   同一个号码加密两次结果不一样，所以无法用它做去重。
 * - 指纹（phoneHash）：HMAC + pepper，同一号码永远得到同一指纹，
 *   用来建唯一索引做去重、以及按号码精确查找。
 *   加 pepper 是防止别人拿手机号字典反推库里有哪些号。
 * - 掩码（phoneMask）：界面展示用，138****8000。
 */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) throw new Error("FIELD_ENCRYPTION_KEY 未配置");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`FIELD_ENCRYPTION_KEY 必须是 32 字节的 base64（当前 ${buf.length} 字节）`);
  }
  return buf;
}

function pepper(): Buffer {
  const raw = process.env.PHONE_HASH_PEPPER;
  if (!raw) throw new Error("PHONE_HASH_PEPPER 未配置");
  return Buffer.from(raw, "base64");
}

/** 加密。输出 iv:tag:ciphertext，全部 base64 */
export function encryptField(plain: string): string {
  const iv = randomBytes(12); // GCM 推荐 96 bit
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/**
 * 解密。密文被篡改时 GCM 会抛错 —— 这是特性不是 bug，
 * 说明数据被动过，宁可报错也不能返回错误的手机号。
 */
export function decryptField(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("密文格式不合法");
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 指纹。同一号码恒定，用于唯一索引去重 */
export function hashPhone(phone: string): string {
  return createHmac("sha256", pepper()).update(normalizePhone(phone)).digest("hex");
}

/** 掩码：13812348000 → 138****8000 */
export function maskPhone(phone: string): string {
  const p = normalizePhone(phone);
  if (p.length !== 11) return "***";
  return `${p.slice(0, 3)}****${p.slice(7)}`;
}

/** 去掉空格、横线、+86 前缀 */
export function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s-]/g, "");
  if (p.startsWith("+86")) p = p.slice(3);
  if (p.startsWith("86") && p.length === 13) p = p.slice(2);
  return p;
}

/** 一次算出三种形态，入库时用 */
export function preparePhone(phone: string) {
  const normalized = normalizePhone(phone);
  return {
    phoneEnc: encryptField(normalized),
    phoneHash: hashPhone(normalized),
    phoneMask: maskPhone(normalized),
  };
}

/** 定长比较，防时序攻击。用于令牌校验 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 抽取输入的指纹，用于幂等：同一段对话不重复调模型、不重复计费 */
export function hashInput(text: string): string {
  return createHmac("sha256", "extract-idempotency").update(text.trim()).digest("hex");
}
