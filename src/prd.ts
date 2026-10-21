import fs from 'node:fs';
import type { Task } from './state.js';

// PRD 回填:任务 done 时把「有硬证据的条目」勾上,并填实现记录。
//
// 为什么必须由 CLI 做、不能写进技能提示让 agent 做:
//   四个平台(Claude/Codex/OpenCode/Antigravity)的 agent 各自渲染 prompt,
//   若回填依赖模型照做,格式/时机/是否做全都会漂移 —— 同一份代码在不同 agent 下
//   产出不同的 PRD。放在 CLI 里,行为跨平台逐字节一致。
//
// 回填边界(宁可少勾,不可假勾):
//   - 只勾 `- [ ] \`cmd\`` 形式且该 cmd 出现在 verify_passed.commands 里的条目 —— 有执行回执。
//   - 散文式验收条目(无逐条核验回执)一律保持未勾,并在状态横幅里说明原因。
//     全部打勾会制造"看起来逐条验过"的假象,与 nightowl 反 false-green 的立场冲突。

/** 验收区状态横幅的起始标记(用于幂等替换)。 */
const BANNER_MARK = '> 🤖 nightowl:';

export interface BackfillResult {
  /** 是否真的改写了文件。 */
  changed: boolean;
  /** 被勾选的命令数。 */
  checkedCommands: number;
  /** 跳过原因(文件不存在/无验收区等),供 done 输出一行提示。 */
  skipped?: 'no-prd' | 'no-acceptance' | 'error';
}

/** 从 `- [ ] \`cmd\`` 形式的行里取出 cmd;不是该形式返回 null。 */
function commandBullet(line: string): string | null {
  const m = /^\s*[-*]\s+\[\s\]\s+`([^`]+)`\s*$/.exec(line);
  return m ? m[1] : null;
}

function checkedBullet(cmd: string): string {
  return `- [x] \`${cmd}\``;
}

/** 渲染事实型实现记录(全部来自状态文件,无自由发挥)。 */
function renderRecord(task: Task, actualMin: number, finishedAt: string, commit: string | null): string {
  const lines: string[] = [];
  lines.push('<!-- 本段由 nightowl done 自动回填,内容均来自 .nightowl 状态文件 -->');
  lines.push('');
  lines.push(`- 完成时间: ${finishedAt}`);
  lines.push(`- 实际用时: ${actualMin} 分(估值 ${task.est_min ?? '-'} 分)`);
  if (task.verify_passed) {
    lines.push(`- 验证: ALL_PASS @ ${task.verify_passed.at}`);
    for (const c of task.verify_passed.commands) lines.push(`  - \`${c}\``);
    if (task.verify_passed.head) {
      lines.push(`- 代码版本: ${task.verify_passed.head.slice(0, 12)}`);
    } else {
      lines.push('- 代码版本: 未绑定(非 git 环境,防偷改校验未生效)');
    }
    if (task.verify_passed.dirty_diff_hash) {
      lines.push(`- 工作区指纹: ${task.verify_passed.dirty_diff_hash}`);
    }
  } else {
    lines.push('- 验证: 未执行(--force 跳过)');
  }
  if (task.review) {
    lines.push(`- 审查: ${task.review.result} (${task.review.level}) @ ${task.review.at}`);
    if (task.review.note) lines.push(`  - 备注: ${task.review.note}`);
  } else {
    lines.push('- 审查: 未执行(--force 跳过)');
  }
  lines.push(`- 合并 commit: ${commit ? commit.slice(0, 12) : '未找到 [#id] 标记 commit'}`);
  return lines.join('\n');
}

/**
 * 回填 PRD 的验收勾选与实现记录。纯函数式改写,幂等。
 * 任何异常都吞掉并返回 skipped:'error' —— 文档回填是便利功能,绝不能让 done 失败。
 */
export function backfillPrd(
  prdPath: string | undefined,
  task: Task,
  actualMin: number,
  finishedAt: string,
  commit: string | null,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p: string, s: string) => void = (p, s) => fs.writeFileSync(p, s, 'utf8'),
): BackfillResult {
  if (!prdPath) return { changed: false, checkedCommands: 0, skipped: 'no-prd' };
  let text: string;
  try {
    text = readFile(prdPath);
  } catch {
    return { changed: false, checkedCommands: 0, skipped: 'no-prd' };
  }
  try {
    const lines = text.split('\n');

    // 定位验收区(到下一个 ## 标题为止)
    const start = lines.findIndex((l) => /^##\s+Acceptance Criteria/i.test(l));
    if (start === -1) return { changed: false, checkedCommands: 0, skipped: 'no-acceptance' };
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }

    // 只有拿到执行回执的命令才勾 —— verify_passed.commands 是硬证据
    const passed = new Set(task.verify_passed?.commands ?? []);
    let checked = 0;
    for (let i = start + 1; i < end; i += 1) {
      const cmd = commandBullet(lines[i]);
      if (cmd && passed.has(cmd)) {
        lines[i] = checkedBullet(cmd);
        checked += 1;
      }
    }
    const hadUnchecked = checked > 0;

    // 状态横幅:放在验收区标题下第一行,幂等(已存在则整行替换)
    const banner = [
      `${BANNER_MARK} 任务状态 ${task.status === 'done' ? '✅ done' : task.status} @ ${finishedAt}`,
      `> 审查 ${task.review?.result ?? '未执行'} · 验证 ${task.verify_passed ? 'ALL_PASS' : '未执行'}`,
      '> 未勾选条目为自述式验收(无逐条核验回执),复核请以 `.nightowl/nightowl.report.md` 为准。',
    ];
    let bannerAt = -1;
    for (let i = start + 1; i < end; i += 1) {
      if (lines[i].startsWith(BANNER_MARK)) {
        bannerAt = i;
        break;
      }
    }
    if (bannerAt === -1) {
      // 插到标题后的空行之后
      let insertAt = start + 1;
      while (insertAt < end && lines[insertAt].trim() === '') insertAt += 1;
      lines.splice(insertAt, 0, ...banner, '');
    } else {
      // 替换旧横幅(固定 3 行)
      lines.splice(bannerAt, 3, ...banner);
    }

    // 实现记录:替换那段 HTML 注释占位
    const recStart = lines.findIndex((l) => /^##\s+Implementation Record/i.test(l));
    if (recStart !== -1) {
      let recEnd = lines.length;
      for (let i = recStart + 1; i < lines.length; i += 1) {
        if (/^##\s+/.test(lines[i])) {
          recEnd = i;
          break;
        }
      }
      const body = renderRecord(task, actualMin, finishedAt, commit);
      lines.splice(recStart + 1, recEnd - recStart - 1, '', body, '');
    }

    const out = lines.join('\n');
    if (out === text) return { changed: false, checkedCommands: 0 };
    writeFile(prdPath, out);
    return { changed: true, checkedCommands: hadUnchecked ? checked : 0 };
  } catch {
    return { changed: false, checkedCommands: 0, skipped: 'error' };
  }
}
