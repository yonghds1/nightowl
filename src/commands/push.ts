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

export function isNonFastForward(stderr: string): boolean {
  return NON_FAST_FORWARD.test(stderr);
}

function fail(msg: string, token: string): never {
  console.error(msg);
  console.error(token);
  process.exit(1);
}

export function createPushCommand(): Command {
  return new Command('push')
    .description(t('push.desc'))
    .action(() => {
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

      // 分支从没推过时 <remote>/<branch> 不存在,视为全部未推送;此时用 -u 建立跟踪,
      // 否则下次推送仍然没有可比对的 upstream。
      const remoteRef = `${remote}/${branch}`;
      const hasRemoteRef =
        git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}`]).code === 0;
      const unpushed = hasRemoteRef
        ? git(['log', `${remoteRef}..HEAD`, '--oneline']).stdout
        : git(['log', '--oneline']).stdout;
      if (!unpushed.trim()) {
        console.log(t('push.nothing', { branch }));
        console.log('PUSH_NOTHING');
        return;
      }
      console.log(t('push.unpushed', { n: unpushed.split('\n').filter(Boolean).length }));
      console.log(unpushed);

      const args = ['push'];
      if (!hasRemoteRef) args.push('-u');
      args.push(remote, branch);
      const r = git(args);
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
