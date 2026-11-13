// 从 Nest 的元数据里列出应用的全部路由（不依赖 Express 内部结构）。
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { IS_PUBLIC } from "../../src/auth/public.decorator";
import { PLATFORM_ROUTE } from "../../src/platform/platform.decorators";

export interface RouteInfo {
  method: string;
  path: string;
  isPublic: boolean;
  /** 平台入口的接口（只在主机名 platform.* 上可用） */
  isPlatform: boolean;
}

function join(...parts: string[]): string {
  return "/" + parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

export function listRoutes(controllers: Array<new (...args: never[]) => unknown>): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const controller of controllers) {
    const base: string = Reflect.getMetadata(PATH_METADATA, controller) ?? "";
    const classPlatform = Reflect.getMetadata(PLATFORM_ROUTE, controller) === true;
    const classPublic = Reflect.getMetadata(IS_PUBLIC, controller) === true;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      // 只看方法：getter（比如 private get db()）在原型上读取会报错
      const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value;
      if (typeof handler !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined) continue;
      const path: string = Reflect.getMetadata(PATH_METADATA, handler) ?? "";
      out.push({
        method: RequestMethod[method],
        path: join(base, path),
        isPlatform: classPlatform || Reflect.getMetadata(PLATFORM_ROUTE, handler) === true,
        isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true,
      });
    }
  }
  return out;
}
