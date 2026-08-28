/**
 * 会话令牌的签发与校验。
 *
 * ⚠️ 本文件必须保持 edge runtime 兼容 —— middleware 会 import 它。
 * 所以只能用 Web Crypto（crypto.subtle）和 TextEncoder，
 * 不能用 node:crypto、不能用 Buffer、不能碰数据库。
 *
 * 设计：无状态签名令牌，不建 session 表。
 * 单用户系统没有"踢下线"需求，签名 + 短有效期足够，
 * 而且省掉每次请求一次数据库查询。
 * 代价是无法主动吊销 —— 换 SESSION_SECRET 即可让全部令牌失效。
 */

const encoder = new TextEncoder();

/**
 * 令牌有效期 30 天。
 * 单人系统 + 移动端为主的使用场景，频繁登录的摩擦大于会话延长带来的风险；
 * 且系统未暴露任何写入型公开接口，会话被盗的影响面可控。
 */
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export const SESSION_COOKIE = "az_session";

type Payload = { sub: string; exp: number };

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** 签发令牌：base64url(payload).base64url(hmac) */
export async function signSession(
  sub: string,
  secret: string,
  maxAgeSec = SESSION_MAX_AGE_SEC
): Promise<string> {
  const payload: Payload = {
    sub,
    exp: Math.floor(Date.now() / 1000) + maxAgeSec,
  };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(body)
  );
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * 校验令牌。任何异常一律返回 null —— fail closed。
 * 用 crypto.subtle.verify 而不是自己比字符串，它本身是定长比较。
 */
export async function verifySession(
  token: string | undefined,
  secret: string
): Promise<Payload | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!sigPart) return null;

  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(sigPart) as unknown as ArrayBuffer,
      encoder.encode(body)
    );
    if (!ok) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(body))
    ) as Payload;
    if (typeof payload.exp !== "number" || typeof payload.sub !== "string") {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
