"use client";

import * as React from "react";
import { InDialogContext } from "./modal";

/** 底边留白（px） */
const GAP = 24;

/**
 * 让一块区域的高度刚好撑到屏幕底边：返回要挂到该区域的 ref 和算出的最大高度。
 * 区域里的内容超出就在区域内部滚动，区域上方的标题、操作区不动。
 * extraBottom：区域下面还有别的东西要留位置（比如分页条）。在弹窗里不限制高度（弹窗自己滚动）。
 */
export function useFitHeight<T extends HTMLElement>(extraBottom = 0): { ref: React.RefObject<T | null>; maxHeight: number | undefined } {
  const inDialog = React.useContext(InDialogContext);
  const ref = React.useRef<T>(null);
  const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);
  const fit = React.useCallback(() => {
    const el = ref.current;
    if (!el || inDialog) return;
    setMaxHeight(Math.max(180, Math.floor(window.innerHeight - el.getBoundingClientRect().top - GAP - extraBottom)));
  }, [inDialog, extraBottom]);
  React.useLayoutEffect(() => { fit(); });
  React.useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);
  return { ref, maxHeight };
}
