// 给"登录往返"cookie（state、PKCE 校验码、登录后回到哪里）签名，防篡改。
// 签名用 HMAC-SHA256；内容不加密（里面没有令牌），但 cookie 是 httpOnly 的。
import { createHmac, timingSafeEqual } from "node:crypto";

const mac = (secret: string, payload: string): string => createHmac("sha256", secret).update(payload).digest("base64url");

export function sign(value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

export function verify<T>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
