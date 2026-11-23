// FlowMate · URL 状态的纯合并逻辑（不放 React 依赖，方便直接单测）
// 为什么单独成文件：这个函数决定「点了文件之后当前目录还在不在」，
// 之前它内联在 useUrlState 里、且依赖 location/history，没法在 Node 里测；
// 抽出纯函数后，回归可以只喂对象、不碰浏览器。

export function mergeUrlState(
  defaults: Record<string, string>, cur: Record<string, string>, patch: Record<string, string | null>,
): Record<string, string> {
  const next: Record<string, string> = { ...defaults };
  for (const k of Object.keys(defaults)) {
    if (typeof cur?.[k] === 'string') next[k] = cur[k];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in defaults)) continue;
    next[k] = v === null ? defaults[k] : v;
  }
  return next;
}

/** 序列化成 query：默认值不写进 URL，保持地址栏干净 */
export function urlStateToQuery(next: Record<string, string>, defaults: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) { if (v !== '' && v !== defaults[k]) p.set(k, v); }
  return p.toString();
}
