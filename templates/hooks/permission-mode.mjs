// nightowl PreToolUse hook:每次工具调用前,把当前会话权限模式写入 .nightowl/.permission-mode。
// 供 `nightowl selfcheck` 读取,避免 LLM 凭空猜测权限模式。
// 退出码 0 且不输出 JSON → 不拦截任何工具调用,走正常权限流程。
import fs from 'node:fs';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(input);
    const mode = typeof j.permission_mode === 'string' ? j.permission_mode : '';
    const cwd = typeof j.cwd === 'string' && j.cwd ? j.cwd : process.cwd();
    fs.mkdirSync(`${cwd}/.nightowl`, { recursive: true });
    fs.writeFileSync(`${cwd}/.nightowl/.permission-mode`, mode, 'utf8');
  } catch {
    // 静默失败,退出 0,不拦截工具调用
  }
});
