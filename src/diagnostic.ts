// 验收/复验失败时的可读诊断:截断长输出,保留关键错误行与尾部堆栈。
// 独立成模块:verify(单任务门禁)与 worktree merge(合并后复验)共用,避免循环依赖。

const DIAGNOSTIC_MAX_LEN = 2000;
const DIAGNOSTIC_TAIL_LINES = 30;
const DIAGNOSTIC_KEY_MAX_LINES = 15;
const KEYWORDS = ['FAIL', 'ERROR', 'Error:', 'Failed:', 'AssertionError'];

/**
 * 从 stdout/stderr 中提取可读的诊断摘要。
 * - 总长度不超过 2000 字符时整段返回,避免任何切割。
 * - 超过时保留尾部 30 行,并补充包含 FAIL/ERROR/Error:/Failed:/AssertionError 的关键行段落(最多 15 行)。
 */
export function extractDiagnostic(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  if (combined.length <= DIAGNOSTIC_MAX_LEN) {
    return combined;
  }

  const lines = combined.split('\n');
  const tailLines = lines.slice(-DIAGNOSTIC_TAIL_LINES);

  // 收集关键行及其紧邻上下文,形成可读段落。
  const keyIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && KEYWORDS.some((k) => line.includes(k))) {
      keyIndices.add(i);
      if (i > 0) keyIndices.add(i - 1);
      if (i < lines.length - 1) keyIndices.add(i + 1);
    }
  }

  const sorted = Array.from(keyIndices).sort((a, b) => a - b);
  const keyLines: string[] = [];
  for (const idx of sorted) {
    if (keyLines.length >= DIAGNOSTIC_KEY_MAX_LINES) break;
    keyLines.push(lines[idx]);
  }

  const parts: string[] = [];
  if (keyLines.length > 0) {
    parts.push('...(关键错误摘要)...', ...keyLines, '...(省略中间输出)...');
  }
  parts.push(...tailLines);
  return parts.join('\n');
}
