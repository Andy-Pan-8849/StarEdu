// 顶部标签页的状态（纯函数）：打开 = 已有则激活、没有则追加；关闭 = 激活相邻的一个。
export interface TabItem {
  id: string;
  title: string;
}
export interface TabsState {
  tabs: TabItem[];
  activeId: string | null;
}

export const emptyTabs: TabsState = { tabs: [], activeId: null };

export function openTab(state: TabsState, tab: TabItem): TabsState {
  return state.tabs.some((t) => t.id === tab.id) ? { ...state, activeId: tab.id } : { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  const next = tabs[index] ?? tabs[index - 1] ?? null; // 先右邻、再左邻
  return { tabs, activeId: next?.id ?? null };
}
