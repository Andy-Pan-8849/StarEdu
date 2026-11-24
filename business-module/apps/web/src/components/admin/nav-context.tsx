"use client";

import * as React from "react";

/** 外壳提供的"打开某个页面"：首页的卡片点击后用它在标签页里打开对应的菜单页（按页面组件路径找菜单；没有这个菜单权限就什么也不做）。 */
export const NavContext = React.createContext<{ openPage: (component: string) => boolean }>({ openPage: () => false });
export const useNav = () => React.useContext(NavContext);
