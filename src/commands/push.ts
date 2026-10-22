import { Command } from 'commander';
import { git, gitCurrentBranch, probeGit } from '../git.js';
import { log } from '../state.js';
import { t } from '../i18n.js';

/**
 * 选推送 remote:优先当前分支已跟踪的 remote → origin → 唯一 remote。
 * 多个 remote 且无 origin/无跟踪时返回 null(歧义),由调用方报可执行的修复命令。
 */
export function selectPushRemote(remotes: string[], trackedRemote: string | null): string | null {
  if (!remotes.length) return null;
  if (trackedRemote && trackedRemote !== '.' && remotes.includes(trackedRemote)) return trackedRemote;
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0] : null;
}

/** 远端拒绝的典型文案(non-fast-forward / 需要先 fetch / 钩子拒绝)。 */
const NON_FAST_FORWARD = /non-fast-forward|fetch first|\[rejected\]|\[remote rejected\]|pre-receive hook declined/i;

/** fetch/push 走网络,慢链路(或大仓)经常超过本地 git 的 60s 默认超时。 */
const NETWORK_TIMEOUT_MS = 300_000;

export function isNonFastForward(stderr: string): boolean {
  return NON_FAST_FORWARD.test(stderr);
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** 相对远端分支的领先/落后提交数;远端 ref 不存在时返回 null。 */
export function aheadBehind(remoteRef: string): AheadBehind | null {
  const r = git(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]);
  if (r.code !== 0) return null;
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

/** 分支是否配置了 upstream(branch.<name>.merge)。 */
function hasUpstream(branch: string): boolean {
  return Boolean(git(['config', '--get', `branch.${branch}.merge`]).stdout.trim());
}

function fail(msg: string, token: string): never {
  console.error(msg);
  console.error(token);
  process.exit(1);
}

function nothingToPush(branch: string): void {
  console.log(t('push.nothing', { branch }));
  console.log('PUSH_NOTHING');
}

export function createPushCommand(): Command {
  return new Command('push')
    .description(t('push.desc'))
    .option('--no-fetch', '不先 fetch,直接用本地已知的远端状态判断')
    .action((opts: { fetch: boolean }) => {
      console.log(t('push.title'));
      // 非 git 环境(多仓父目录)没有统一的 remote 可推:推送只能发生在有 git 的仓库。
      // 各子仓的推送由任务命令自带(cd 子仓 && git push),nightowl 不越俎代庖。
      if (!probeGit().isRepo) {
        console.log('PUSH_SKIPPED_NO_GIT');
        return;
      }
      const remotes = git(['remote']).stdout.split(/\s+/).filter(Boolean);
      if (!remotes.length) {
        console.log(t('push.noRemote'));
        console.log('PUSH_SKIPPED_NO_REMOTE');
        return;
      }

      const branch = gitCurrentBranch();
      if (!branch) {
        fail(t('push.detached'), 'PUSH_DETACHED');
      }

      const trackedRemote = git(['config', '--get', `branch.${branch}.remote`]).stdout.trim() || null;
      const remote = selectPushRemote(remotes, trackedRemote);
      if (!remote) {
        fail(t('push.noRemoteSelected', { branch, remotes: remotes.join(', ') }), 'PUSH_NO_REMOTE_SELECTED');
      }

      // 先 fetch:否则 <remote>/<branch> 可能是几小时前的快照,既会虚报未推送数量,
      // 也会把"远端已前进"的分叉误当成普通可快进推送。fetch 失败不阻断(继续用本地状态)。
      if (opts.fetch !== false) {
        const fetched = git(['fetch', '--quiet', remote], { timeoutMs: NETWORK_TIMEOUT_MS });
        if (fetched.code !== 0) {
          console.error(
            t('push.fetchFailed', { remote, err: (fetched.stderr || fetched.stdout).slice(-300) }),
          );
        }
      }

      const remoteRef = `${remote}/${branch}`;
      const hasRemoteRef =
        git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}`]).code === 0;

      if (hasRemoteRef) {
        const ab = aheadBehind(remoteRef);
        if (ab) {
          if (ab.ahead === 0 && ab.behind === 0) {
            nothingToPush(branch);
            return;
          }
          // 双方都有新提交:先同步再推,直接 push 只会被拒并留下模糊报错
          if (ab.ahead > 0 && ab.behind > 0) {
            fail(
              t('push.diverged', { remote, branch, ahead: ab.ahead, behind: ab.behind }),
              'PUSH_DIVERGED',
            );
          }
          // 只落后不领先:本地没有可推内容
          if (ab.ahead === 0) {
            nothingToPush(branch);
            return;
          }
        }
      }

      // 未知远端 ref 时视为全部未推送
      const unpushed = hasRemoteRef
        ? git(['log', `${remoteRef}..HEAD`, '--oneline']).stdout
        : git(['log', '--oneline']).stdout;
      if (!unpushed.trim()) {
        nothingToPush(branch);
        return;
      }
      console.log(t('push.unpushed', { n: unpushed.split('\n').filter(Boolean).length }));
      console.log(unpushed);

      // upstream 是否已配置决定要不要 -u:远端 ref 存在 ≠ 本地分支已跟踪它。
      // 只看 ref 会导致"推成功了但 git status 永远不显示 ahead/behind"。
      const args = ['push'];
      if (!hasUpstream(branch)) args.push('-u');
      args.push(remote, branch);
      const r = git(args, { timeoutMs: NETWORK_TIMEOUT_MS });
      if (r.code === 0) {
        console.log(t('push.ok', { branch }));
        log(t('push.log', { remote, branch }));
        console.log('PUSH_OK');
        return;
      }

      if (isNonFastForward(r.stderr)) {
        fail(t('push.rejected', { remote, branch, err: r.stderr.slice(-500) }), 'PUSH_REJECTED');
      }
      fail(t('push.failed', { err: r.stderr.slice(-500) }), 'PUSH_FAIL');
    });
}
