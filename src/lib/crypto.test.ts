import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptField,
  decryptField,
  hashPhone,
  maskPhone,
  normalizePhone,
  preparePhone,
  safeEqual,
} from "./crypto";

beforeAll(() => {
  // 测试用密钥，与生产无关
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.PHONE_HASH_PEPPER = randomBytes(32).toString("base64");
});

describe("加密往返", () => {
  it("加密后能原样解回来", () => {
    const phone = "13812348000";
    expect(decryptField(encryptField(phone))).toBe(phone);
  });

  it("同一个号码两次加密结果不同（IV 随机）", () => {
    const a = encryptField("13812348000");
    const b = encryptField("13812348000");
    expect(a).not.toBe(b);
    // 但都能解回同一个值
    expect(decryptField(a)).toBe(decryptField(b));
  });

  it("中文也能正确处理", () => {
    const s = "李某某，负债较高需要养征信";
    expect(decryptField(encryptField(s))).toBe(s);
  });
});

describe("篡改检测（GCM 的核心价值）", () => {
  it("改动密文会抛错，而不是返回错误数据", () => {
    const enc = encryptField("13812348000");
    const [iv, tag, data] = enc.split(":");
    // 翻转密文最后一个字符
    const broken = Buffer.from(data, "base64");
    broken[broken.length - 1] ^= 0xff;
    const tampered = [iv, tag, broken.toString("base64")].join(":");
    expect(() => decryptField(tampered)).toThrow();
  });

  it("改动认证标签会抛错", () => {
    const enc = encryptField("13812348000");
    const [iv, , data] = enc.split(":");
    const fakeTag = randomBytes(16).toString("base64");
    expect(() => decryptField([iv, fakeTag, data].join(":"))).toThrow();
  });

  it("格式不合法会抛错", () => {
    expect(() => decryptField("garbage")).toThrow("密文格式不合法");
  });
});

describe("密钥校验", () => {
  it("密钥长度不对时明确报错，不静默降级", () => {
    const saved = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = Buffer.from("tooshort").toString("base64");
    expect(() => encryptField("x")).toThrow(/32 字节/);
    process.env.FIELD_ENCRYPTION_KEY = saved;
  });
});

describe("手机号规范化", () => {
  it.each([
    ["13812348000", "13812348000"],
    ["138 1234 8000", "13812348000"],
    ["138-1234-8000", "13812348000"],
    ["+8613812348000", "13812348000"],
    ["8613812348000", "13812348000"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe("指纹去重", () => {
  it("同一号码指纹恒定", () => {
    expect(hashPhone("13812348000")).toBe(hashPhone("13812348000"));
  });

  it("不同格式的同一号码指纹相同（这是去重的关键）", () => {
    expect(hashPhone("138 1234 8000")).toBe(hashPhone("+8613812348000"));
  });

  it("不同号码指纹不同", () => {
    expect(hashPhone("13812348000")).not.toBe(hashPhone("13812348001"));
  });

  it("指纹不含原始号码", () => {
    expect(hashPhone("13812348000")).not.toContain("1381234");
  });
});

describe("掩码展示", () => {
  it("正常号码打码中间四位", () => {
    expect(maskPhone("13812348000")).toBe("138****8000");
  });

  it("异常长度不泄露内容", () => {
    expect(maskPhone("123")).toBe("***");
  });
});

describe("preparePhone 三件套", () => {
  it("一次产出加密值、指纹、掩码", () => {
    const r = preparePhone("138 1234 8000");
    expect(decryptField(r.phoneEnc)).toBe("13812348000");
    expect(r.phoneHash).toBe(hashPhone("13812348000"));
    expect(r.phoneMask).toBe("138****8000");
  });
});

describe("safeEqual", () => {
  it("相同为 true", () => expect(safeEqual("abc123", "abc123")).toBe(true));
  it("不同为 false", () => expect(safeEqual("abc123", "abc124")).toBe(false));
  it("长度不同为 false，不抛错", () => expect(safeEqual("abc", "abcdef")).toBe(false));
});
