import type { AppState, Pool } from './state.js';

// 报告备注的时效性处理。
//
// 问题:Review.note 是审查当时 agent 写的自由文本,存进任务池后不再重算。
// 于是报告里会出现"静态陈述"与当前状态矛盾的情况 —— 实测例子:M5 的备注写着
// "M6 仍需完成",但 M6 后来已经完成,报告却仍原样照搬。
//
// 为什么不在 note 里做文本改写(把"M6 仍需完成"改成"M6 已完成"):
//   note 是历史事实的记录,篡改它等于伪造审查记录。正确做法是保留原文,
//   在旁边标注这句判断所依据的任务后来如何了 —— 读者能同时看到"当时怎么想"
//   和"后来实际怎样",而不是看到一个被悄悄改过的版本。
//
// 因此在报告里对一个 note 追加时效后缀:
//   - note 提到的任务 id 现在已完成 → 后缀列出它们(说明该判断可能已过时)
//   - note 提到的任务 id 仍待办/阻塞 → 后缀说明仍未完成(判断仍成立)

/** 任务 id 的边界匹配:避免 T1 命中 T10。id 通常是大写字母+数字(M1/M6/T1)。 */
function mentionedIds(note: string, allIds: string[]): string[] {
  const hits: string[] = [];
  for (const id of allIds) {
    // 前后不能紧邻字母数字,避免子串误命中
    const re = new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`);
    if (re.test(note)) hits.push(id);
  }
  return hits;
}

export interface NoteFreshness {
  /** 需要追加的时效说明;null 表示 note 未提及任何任务 id,无需标注。 */
  suffix: string | null;
  /** note 提及且已完成的任务 id(调试/测试用)。 */
  completedIds: string[];
  /** note 提及但仍未完成的任务 id。 */
  pendingIds: string[];
}

/**
 * 计算一条历史备注的时效说明。
 *
 * @param note     审查当时写的原文
 * @param allIds   任务池里全部任务 id
 * @param doneIds  当前已完成的任务 id 集合
 */
export function noteFreshness(
  note: string,
  allIds: string[],
  doneIds: Set<string>,
): NoteFreshness {
  if (!note) return { suffix: null, completedIds: [], pendingIds: [] };
  const mentioned = mentionedIds(note, allIds);
  if (!mentioned.length) return { suffix: null, completedIds: [], pendingIds: [] };
  const completedIds = mentioned.filter((id) => doneIds.has(id));
  const pendingIds = mentioned.filter((id) => !doneIds.has(id));
  const parts: string[] = [];
  if (completedIds.length) {
    parts.push(`${completedIds.join('、')} 此后已完成`);
  }
  if (pendingIds.length) {
    parts.push(`${pendingIds.join('、')} 仍未完成`);
  }
  if (!parts.length) return { suffix: null, completedIds, pendingIds };
  return { suffix: `〔时效:${parts.join(';')}〕`, completedIds, pendingIds };
}

/** 便捷包装:直接从 pool + state 计算。 */
export function noteFreshnessFor(pool: Pool, state: AppState, note: string): NoteFreshness {
  const allIds = pool.pool.map((t) => t.id);
  const doneIds = new Set(state.completed.map((c) => c.id));
  return noteFreshness(note, allIds, doneIds);
}
