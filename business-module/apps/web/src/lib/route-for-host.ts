// 同一个 Next.js 应用服务三个入口：
//   租户网址 <代码>.staredu.com        /       学生门户
//                                      /admin  管理后台
//   平台网址 platform.staredu.com      /       平台入口（内部改写为 /platform）
// 本地用 *.localhost（hq.localhost:3001、platform.localhost:3001）。
export function isPlatformHost(host: string | null | undefined): boolean {
  const name = (host ?? "").split(":")[0].toLowerCase();
  return name === "platform" || name.startsWith("platform.");
}

/** 返回要内部改写到的路径；不需要改写则返回 null。 */
export function rewriteTarget(host: string | null | undefined, pathname: string): string | null {
  if (!isPlatformHost(host)) return null;
  if (pathname === "/platform" || pathname.startsWith("/platform/")) return null;
  if (pathname.startsWith("/bff/")) return null; // 浏览器调接口的通道，平台和租户共用一个处理器
  return pathname === "/" ? "/platform" : `/platform${pathname}`;
}
