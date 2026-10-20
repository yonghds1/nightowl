// nightowl PreToolUse hook:每次工具调用前,把当前会话权限模式写入 .nightowl/.permission-mode。
// 供 `nightowl selfcheck` 读取,避免 LLM 凭空猜测权限模式。
// 退出码 0 且不输出 JSON → 不拦截任何工具调用,走正常权限流程。
import fs from 'node:fs';
import path from 'node:path';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(input);
    const mode = typeof j.permission_mode === 'string' ? j.permission_mode : '';
    // 必须写回项目根,不能用子代理的 cwd:子代理在 worktrees/<id> 里跑工具时,
    // 按 cwd 拼会造出 worktrees/<id>/.nightowl 这个未跟踪文件,让 worktree cleanup
    // 误判 WORKTREE_DIRTY 而拒绝清理 —— 无人值守下会累积残留 worktree 卡死后续合并。
    const cwd = (typeof j.cwd === 'string' && j.cwd) || process.cwd();
    const projectDir = process.env.CLAUDE_PROJECT_DIR || '';
    let base = '';
    if (projectDir && fs.existsSync(path.join(projectDir, '.nightowl'))) {
      base = projectDir;
    } else {
      // 兜底:从 cwd 向上找已存在的 .nightowl(worktree 内也能找回项目根)
      let dir = cwd;
      for (;;) {
        if (fs.existsSync(path.join(dir, '.nightowl'))) {
          base = dir;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    // 找不到说明 init 还没跑过,不凭空创建目录(退出 0,不拦截工具调用)
    if (!base) process.exit(0);
    fs.writeFileSync(path.join(base, '.nightowl', '.permission-mode'), mode, 'utf8');
  } catch {
    // 静默失败,退出 0,不拦截工具调用
  }
});
