// 泄露扫描的接口登记表。
// 规则：除了标了 @Public() 的接口，应用里每一个路由都必须登记在这里——否则
// "every route is registered" 这个测试失败，逼着新接口的作者把它加进扫描。
// kind：
//   list    返回数组，里面每一行必须属于当前租户
//   detail  按 id 取一行；用 B 的 id 在 A 的网址上取，必须是 404
//   self    返回当前账号自己的信息
export interface LeakEntry {
  method: "GET";
  path: string;
  kind: "list" | "detail" | "self";
  /** detail 用：取哪个夹具里的 id */
  fixture?: "campusId" | "deptId" | "postId";
}

export const LEAK_REGISTRY: LeakEntry[] = [
  { method: "GET", path: "/api/me", kind: "self" },
  { method: "GET", path: "/api/campuses", kind: "list" },
  { method: "GET", path: "/api/campuses/:id", kind: "detail", fixture: "campusId" },
  { method: "GET", path: "/api/depts", kind: "list" },
  { method: "GET", path: "/api/depts/:id", kind: "detail", fixture: "deptId" },
  { method: "GET", path: "/api/posts", kind: "list" },
  { method: "GET", path: "/api/posts/:id", kind: "detail", fixture: "postId" },
];
