import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_FILE } from '../paths.js';
import {
  loadPool,
  loadState,
  saveState,
  saveCheckpoint,
  clearCheckpoint,
  log,
} from '../state.js';
import { fmtDateTime, isoNow } from '../util.js';
import { git } from '../git.js';
import { t as tr } from '../i18n.js';

export function createReportCommand(): Command {
  return new Command('report')
    .description(tr('report.desc'))
    .action(() => {
      const pool = loadPool();
      if (!pool) {
        console.error(tr('common.noPool'));
        process.exit(1);
      }
      const state = loadState();
      const doneIds = new Set(state.completed.map((c) => c.id));
      const blocked = state.blocked;

      const lines: string[] = [];
      lines.push(tr('report.title'), '');
      lines.push(tr('report.generatedAt', { time: fmtDateTime() }));
      lines.push('', tr('report.sectionOverview'), '');
      lines.push(tr('report.tableHeader'));
      lines.push('|------|--------|--------|------|------|------|');
      for (const t of pool.pool) {
        const c = state.completed.find((x) => x.id === t.id);
        const actual = c ? String(c.actual_min) : '—';
        const status = doneIds.has(t.id) ? '✅' : blocked.some((b) => b.id === t.id) ? '🚫' : '⏳';
        const assignee = t.assignee ?? tr('report.noAssignee');
        lines.push(tr('report.tableRow', { id: t.id, assignee, prio: t.priority, est: t.est_min, actual, status }));
      }
      lines.push('');
      if (blocked.length) {
        lines.push(tr('report.sectionBlocked'), '');
        for (const b of blocked) lines.push(`- **${b.id}**: ${b.reason ?? ''}`);
        lines.push('');
      }
      // 审查过程:每个任务的最终裁决 + 历史轮次
      const reviewed = pool.pool.filter((t) => t.review);
      if (reviewed.length) {
        lines.push(tr('report.sectionReview'), '');
        for (const t of reviewed) {
          const final = t.review!;
          const v =
            final.result === 'PASS' ? '✅' : final.result === 'PASS_WITH_NITS' ? '⚠️' : '❌';
          lines.push(
            tr('report.reviewLine', {
              id: t.id,
              mark: v,
              result: final.result,
              note: final.note || tr('report.noNote'),
            }),
          );
          for (const [i, h] of (t.review_history ?? []).entries()) {
            const hv = h.result === 'PASS' ? '✅' : h.result === 'PASS_WITH_NITS' ? '⚠️' : '❌';
            lines.push(
              tr('report.roundLine', {
                n: i + 1,
                mark: hv,
                result: h.result,
                note: h.note || tr('report.noNote'),
              }),
            );
          }
        }
        lines.push('');
      }
      const gitlog = git(['log', '--oneline', '-20']).stdout;
      if (gitlog.trim()) {
        lines.push(tr('report.sectionGit'), '', '```', gitlog, '```', '');
      }
      // 原子写入
      const reportFile = REPORT_FILE();
      fs.mkdirSync(path.dirname(reportFile), { recursive: true });
      const tmp = `${reportFile}.tmp`;
      fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
      fs.renameSync(tmp, reportFile);
      const now = isoNow();
      state.report = now;
      state.last_run = now;
      saveState(state);

      // 报告生成后处理 checkpoint
      const total = pool.pool.length;
      const completed = state.completed.length;
      if (completed >= total) {
        clearCheckpoint();
        log(tr('checkpoint.clearedAll'));
      } else {
        saveCheckpoint(pool, state, { total, completed });
        log(tr('checkpoint.finalSaved', { completed, total }));
      }

      console.log(tr('report.written', { file: reportFile }));
      console.log(lines.join('\n'));
    });
}
