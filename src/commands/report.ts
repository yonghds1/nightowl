import { Command } from 'commander';
import { REPORT_FILE } from '../paths.js';
import {
  loadPool,
  loadState,
  updateState,
  saveCheckpoint,
  clearCheckpoint,
  atomicWrite,
  log,
  Pool,
  AppState,
} from '../state.js';
import { fmtDateTime, isoNow } from '../util.js';
import { git } from '../git.js';
import { verificationEvidence, reviewEvidence } from '../evidence.js';
import { noteFreshnessFor } from '../report-freshness.js';
import { t as tr } from '../i18n.js';

export interface ExecutiveSummary {
  verdict: 'READY' | 'CONDITIONAL' | 'BLOCKED';
  verdictReason: string;
  total: number;
  done: number;
  blocked: number;
  pending: number;
  p0Total: number;
  p0Done: number;
  totalEst: number;
  totalActual: number;
  deviationRatio: number | null; // null 表示无实际耗时记录
  reviewFailRounds: number;
  nitsCount: number;
  evidenceMissing: string[];
  evidenceInvalid: string[];
}

export function buildExecutiveSummary(pool: Pool, state: AppState): ExecutiveSummary {
  const total = pool.pool.length;
  const doneIds = new Set(state.completed.map((c) => c.id));
  const blockedIds = new Set(state.blocked.map((b) => b.id));
  const done = doneIds.size;
  const blocked = blockedIds.size;
  const pending = total - done - blocked;

  const p0Tasks = pool.pool.filter((t) => t.priority === 'P0');
  const p0Total = p0Tasks.length;
  const p0Done = p0Tasks.filter((t) => doneIds.has(t.id)).length;

  let totalEst = 0;
  let totalActual = 0;
  let hasActual = false;

  for (const c of state.completed) {
    const t = pool.pool.find((x) => x.id === c.id);
    if (t) {
      totalEst += t.est_min;
    }
    if (typeof c.actual_min === 'number') {
      totalActual += c.actual_min;
      hasActual = true;
    }
  }

  const deviationRatio = hasActual && totalEst > 0
    ? (totalActual - totalEst) / totalEst
    : null;

  let reviewFailRounds = 0;
  let nitsCount = 0;

  for (const t of pool.pool) {
    if (t.review?.result === 'PASS_WITH_NITS') nitsCount++;
    if (t.review?.result === 'FAIL') reviewFailRounds++;
    for (const h of t.review_history ?? []) {
      if (h.result === 'FAIL') reviewFailRounds++;
      if (h.result === 'PASS_WITH_NITS') nitsCount++;
    }
  }

  const evidenceMissing: string[] = [];
  const evidenceInvalid: string[] = [];
  for (const task of pool.pool) {
    const verification = verificationEvidence(task);
    const review = reviewEvidence(task);
    if (verification === 'invalid' || review === 'invalid') evidenceInvalid.push(task.id);
    else if (doneIds.has(task.id) && (verification !== 'valid' || review !== 'valid')) evidenceMissing.push(task.id);
  }
  let verdict: 'READY' | 'CONDITIONAL' | 'BLOCKED' = 'READY';
  let verdictReason = tr('report.reasonReady');

  if (evidenceInvalid.length) {
    verdict = 'BLOCKED';
    verdictReason = tr('evidence.reportInvalid', { ids: evidenceInvalid.join(', ') });
  } else if (blocked > 0 || p0Done < p0Total) {
    verdict = 'BLOCKED';
    verdictReason =
      blocked > 0
        ? tr('report.reasonBlocked', { n: blocked })
        : tr('report.reasonP0', { done: p0Done, total: p0Total });
  } else if (evidenceMissing.length || pending > 0 || total === 0) {
    verdict = 'CONDITIONAL';
    verdictReason = evidenceMissing.length
      ? tr('evidence.reportMissing', { ids: evidenceMissing.join(', ') })
      : tr('evidence.reportPending', { n: pending });
  } else if (reviewFailRounds > 0 || nitsCount > 0 || (deviationRatio !== null && deviationRatio > 0.3)) {
    verdict = 'CONDITIONAL';
    verdictReason =
      reviewFailRounds > 0
        ? tr('report.reasonReview', { n: reviewFailRounds })
        : nitsCount > 0
        ? tr('report.reasonNits', { n: nitsCount })
        : tr('report.reasonDeviation', { pct: Math.round((deviationRatio ?? 0) * 100) });
  }

  return {
    verdict,
    verdictReason,
    evidenceMissing,
    evidenceInvalid,
    total,
    done,
    blocked,
    pending,
    p0Total,
    p0Done,
    totalEst,
    totalActual,
    deviationRatio,
    reviewFailRounds,
    nitsCount,
  };
}

export function groupGitByTask(gitlog: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of gitlog.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/\[#?([A-Za-z0-9_-]+)\]/);
    const key = match ? `[#${match[1]}]` : tr('report.otherChanges');
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(trimmed);
  }
  return map;
}

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

      const summary = buildExecutiveSummary(pool, state);

      const lines: string[] = [];
      lines.push(tr('report.title'), '');
      lines.push(tr('report.generatedAt', { time: fmtDateTime() }), '');

      // 🚦 10 秒 Executive Summary 看板
      const verdictIcon = tr(
        summary.verdict === 'READY'
          ? 'report.verdictReady'
          : summary.verdict === 'CONDITIONAL'
          ? 'report.verdictConditional'
          : 'report.verdictBlocked',
      );
      lines.push(tr('report.execSummary'), '');
      lines.push(tr('report.releaseLine', { verdict: verdictIcon, reason: summary.verdictReason }));
      lines.push(tr('evidence.reportScope'));
      lines.push(
        tr('report.progressLine', {
          done: summary.done,
          total: summary.total,
          p0Done: summary.p0Done,
          p0Total: summary.p0Total,
          blocked: summary.blocked,
          pending: summary.pending,
        }),
      );
      if (summary.deviationRatio !== null) {
        const sign = summary.deviationRatio >= 0 ? '+' : '';
        const pct = `${sign}${Math.round(summary.deviationRatio * 100)}%`;
        lines.push(
          tr('report.deviationLine', {
            est: summary.totalEst,
            actual: summary.totalActual,
            pct,
            fails: summary.reviewFailRounds,
            nits: summary.nitsCount,
          }),
        );
      } else {
        lines.push(
          tr('report.estimateLine', {
            est: summary.totalEst,
            fails: summary.reviewFailRounds,
            nits: summary.nitsCount,
          }),
        );
      }
      lines.push('');

      lines.push(tr('report.sectionOverview'), '');
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
      // 审查过程:每个任务的最终裁决 + 历史轮次。
      // note 是审查当时的原文,存进任务池后不再重算,直接照搬会出现"静态陈述与当前矛盾"
      // (实测:M5 备注写"M6 仍需完成",而 M6 后来已完成)。这里不改写原文(那等于伪造
      // 审查记录),而是追加时效后缀,让读者同时看到"当时怎么想"和"后来实际怎样"。
      const reviewed = pool.pool.filter((t) => t.review);
      if (reviewed.length) {
        lines.push(tr('report.sectionReview'), '');
        for (const t of reviewed) {
          const final = t.review!;
          const v =
            final.result === 'PASS' ? '✅' : final.result === 'PASS_WITH_NITS' ? '⚠️' : '❌';
          const fresh = noteFreshnessFor(pool, state, final.note);
          const noteText = `${final.note || tr('report.noNote')}${fresh.suffix ?? ''}`;
          lines.push(
            tr('report.reviewLine', {
              id: t.id,
              mark: v,
              result: final.result,
              note: noteText,
            }),
          );
          for (const [i, h] of (t.review_history ?? []).entries()) {
            const hv = h.result === 'PASS' ? '✅' : h.result === 'PASS_WITH_NITS' ? '⚠️' : '❌';
            const hFresh = noteFreshnessFor(pool, state, h.note);
            lines.push(
              tr('report.roundLine', {
                n: i + 1,
                mark: hv,
                result: h.result,
                note: `${h.note || tr('report.noNote')}${hFresh.suffix ?? ''}`,
              }),
            );
          }
        }
        lines.push('');
      }

      // Git log 按 [#id] 聚合分组呈现
      const gitlog = git(['log', '--oneline', '-30']).stdout;
      if (gitlog.trim()) {
        lines.push(tr('report.sectionGit'), '');
        const grouped = groupGitByTask(gitlog);
        for (const [groupName, commits] of grouped.entries()) {
          lines.push(`### ${groupName} (${commits.length} commits)`);
          lines.push('```');
          lines.push(commits.join('\n'));
          lines.push('```', '');
        }
      }

      // 原子写入(锁 + 唯一临时文件),并发 report 不会踩固定 .tmp 名
      const reportFile = REPORT_FILE();
      atomicWrite(reportFile, lines.join('\n'));
      const now = isoNow();
      updateState((fresh) => {
        fresh.report = now;
        fresh.last_run = now;
      });

      // 报告生成后处理 checkpoint
      const freshState = loadState();
      const total = pool.pool.length;
      const completed = freshState.completed.length;
      if (completed >= total) {
        clearCheckpoint();
        log(tr('checkpoint.clearedAll'));
      } else {
        saveCheckpoint(pool, freshState);
      }

      console.log(tr('report.written', { file: reportFile }));
      console.log(lines.join('\n'));
    });
}
