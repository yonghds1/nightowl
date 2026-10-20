import { Command } from 'commander';
import { git, probeGit } from '../git.js';
import { log } from '../state.js';
import { t } from '../i18n.js';

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
      const branch = git(['branch', '--show-current']).stdout || 'main';
      // 分支从没推过时 origin/<branch> 不存在,视为全部未推送
      const remoteRef = `origin/${branch}`;
      const hasRemoteRef = git(['rev-parse', '--verify', '--quiet', remoteRef]).code === 0;
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
      const r = git(['push', 'origin', branch]);
      if (r.code === 0) {
        console.log(t('push.ok', { branch }));
        log(t('push.log', { branch }));
        console.log('PUSH_OK');
      } else {
        console.error(t('push.failed', { err: r.stderr.slice(-500) }));
        console.error('PUSH_FAIL');
        process.exit(1);
      }
    });
}
