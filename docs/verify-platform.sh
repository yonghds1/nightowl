#!/usr/bin/env bash
# Nightowl 平台最小验证 —— 准备阶段脚本
# 作用:为指定 agent 平台建一个隔离临时项目、nightowl init、铺一个"零语言依赖"的 T1 小任务,
#       然后打印出"到该 agent 会话里该做什么 + 该观察什么"。
# 本脚本不驱动 run(那必须在真实 agent 会话里发生);它只把你送到可实测的起点。
#
# 用法:
#   ./docs/verify-platform.sh claude|codex|opencode|antigravity
# 可选:
#   NIGHTOWL="node /path/to/nightowl/dist/cli.js" 覆盖默认的全局 `nightowl`
set -euo pipefail

PLATFORM="${1:-}"
case "$PLATFORM" in claude|codex|opencode|antigravity) ;; *)
  echo "用法: $0 <claude|codex|opencode|antigravity>"; exit 2;; esac

NIGHTOWL="${NIGHTOWL:-nightowl}"
command -v "$NIGHTOWL" >/dev/null 2>&1 || true  # 允许 NIGHTOWL 是带空格的命令串

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nightowl-verify-$PLATFORM.XXXXXX")"
cd "$WORK"

echo "== 平台 $PLATFORM | 临时项目: $WORK =="
git init -q
git config user.email "verify@nightowl.local"; git config user.name "nightowl-verify"
echo "# smoke repo" > README.md
git add README.md && git commit -qm "base"

# Antigravity 权限写全局,测试期把全局指到本目录内,避免污染真实 HOME
if [ "$PLATFORM" = "antigravity" ]; then
  export AGY_SETTINGS_FILE="$WORK/.agy-settings.json"
  echo "(AGY_SETTINGS_FILE → $AGY_SETTINGS_FILE)"
fi

$NIGHTOWL init -u verifier --platform "$PLATFORM"

# 一个纯新增文件、零语言栈依赖的任务:只测调度/子代理/worktree/verify/merge 机制本身
$NIGHTOWL add \
  --id T1 --title "创建 nightowl-smoke.txt" \
  --priority P0 --est-min 5 \
  --desc "在仓库根创建文件 nightowl-smoke.txt,内容为单行 nightowl-ok" \
  --acceptance "存在 nightowl-smoke.txt 且唯一一行内容为 nightowl-ok" \
  --verify "test -f nightowl-smoke.txt && [ \"\$(cat nightowl-smoke.txt)\" = nightowl-ok ]"

echo
echo "== 铺入产物(先核对路径/渲染是否正确)=="
find . -path ./.git -prune -o \( -path '*/skills/nightowl-*' -o -path '*agents*' -o -name 'config.toml' -o -name 'opencode.json' -o -name 'settings.json' \) -type f -print | sort
echo
echo "== 占位符残留检查(应为'无')=="
grep -rl "{{PLATFORM_" "$WORK" --include="SKILL.md" 2>/dev/null || echo "无残留 ✓"

echo
cat <<EOF
== 下一步:进 $PLATFORM 会话实测 ==
1. cd "$WORK"
2. 启动 $PLATFORM,确认它加载了 nightowl 技能(见 checklist 的"发现技能"列)
3. 交互规划(可选,验证 plan):对 agent 说"用 nightowl-plan 看看这个任务池"
4. 开工执行(核心,验证 run):对 agent 说"用 nightowl-run 开工把 T1 做完"
   或无人值守(验证 supervise + headless):退出会话后运行
     $NIGHTOWL supervise --once
5. 收尾核对(见 docs/verify-checklist.md 该平台段落):
   - nightowl status            # T1 是否 completed
   - cat nightowl-smoke.txt     # 是否 nightowl-ok
   - git log --oneline          # 是否含带 T1 的 commit 且已合回主分支
   - git worktree list          # 是否只剩主工作区(无残留)
   - test -f .nightowl/nightowl.report.md   # report 是否落盘
EOF
echo "临时项目保留在 $WORK (验证完自行 rm -rf)"
