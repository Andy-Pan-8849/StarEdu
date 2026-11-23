"use client";

import * as React from "react";

/** 当前公司的名字（菜单顶部显示的那个）；组织架构树的根节点用它。 */
export const BrandNameContext = React.createContext<string>("");
