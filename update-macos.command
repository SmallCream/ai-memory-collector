#!/bin/bash
# One-shot updater for an existing unpacked extension. No credentials or daemon.
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
AI Memory Collector — macOS 更新工具

双击此文件：首次选择浏览器原来加载的 extension 文件夹，以后自动沿用。
  --test      本次从测试渠道更新（不修改默认 main 渠道，可与 --choose 合用）
  --choose    重新选择原安装目录
  --rollback  恢复所选目录最近一次更新前的代码
  --help      显示此说明

首次双击若提示没有执行权限，可在终端输入 bash 和一个空格，拖入此文件后按回车。
无需 sudo、Git、Node 或 Python，不会安装常驻程序。
更新结束后仍需在 chrome://extensions 或 edge://extensions 点击“重新加载”。
不要卸载扩展，不要换目录加载。关闭采集台不会停止后台任务。
更新前暂停自动任务；有进行中的对话任务先“停止本轮”，等待独立传输和文件写入结束。
本工具不读取浏览器任务状态，无法替你确认是否空闲。操作步骤见 docs/macos-update.md。
HELP
}

mode=update
channel=main
for option in "$@"; do
  case "$option" in
    --test) [ "$channel" = main ] || { usage; exit 2; }; channel=test ;;
    --choose|--rollback)
      [ "$mode" = update ] || { usage; exit 2; }
      mode=${option#--} ;;
    --help|-h) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[ "$mode" != rollback ] || [ "$channel" = main ] || { usage; exit 2; }
source_ref='main'
[ "$channel" != test ] || source_ref='feat/automatic-collector-v2'

state_dir=${AMC_UPDATER_STATE_DIR:-"$HOME/Library/Application Support/AI Memory Collector Updater"}
lock_dir="$state_dir/run.lock"
work_dir=''
stage_dir=''
target_dir=''
backup_dir=''
file_list=''
owns_lock=false
replacing=false

cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ "$replacing" = true ] && [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
    if [ ! -e "$target_dir" ]; then
      if mv "$backup_dir" "$target_dir"; then
        printf '\n更新未完成，已恢复原插件目录。\n' >&2
      else
        printf '\n自动恢复失败。原代码仍在：%s\n请将它恢复到：%s\n' "$backup_dir" "$target_dir" >&2
      fi
    fi
  fi
  [ -z "$stage_dir" ] || [ ! -d "$stage_dir" ] || rm -rf "$stage_dir"
  [ -z "$work_dir" ] || [ ! -d "$work_dir" ] || rm -rf "$work_dir"
  [ -z "$file_list" ] || rm -f "$file_list"
  if [ "$owns_lock" = true ]; then rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; fi
  if [ "$result" -ne 0 ]; then printf '\n更新未成功。请根据上方提示处理后再运行；不要卸载插件。\n' >&2; fi
  if [ -t 0 ] && [ -t 1 ]; then printf '\n按回车关闭窗口…'; read -r _ || true; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { printf '\n%s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail '此脚本仅用于 macOS。'
for command_name in curl unzip ditto osascript shasum diff mktemp; do
  command -v "$command_name" >/dev/null || fail "缺少系统命令：$command_name"
done
[ ! -L "$state_dir" ] || fail '更新工具设置目录是符号链接，请先检查该目录。'
mkdir -p "$state_dir"

# mkdir is the lock operation. Do not remove a lock with a missing/invalid PID:
# another process might still be writing it. A dead PID can be recovered.
if ! mkdir "$lock_dir" 2>/dev/null; then
  old_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
  case "$old_pid" in ''|*[!0-9]*) fail "已有更新任务或残留锁，请关闭其他更新窗口。确认没有任务后，可删除：$lock_dir" ;; esac
  if kill -0 "$old_pid" 2>/dev/null; then fail '已有更新任务正在运行，请等待它完成。'; fi
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || fail '无法清理上次更新任务的锁。'
  mkdir "$lock_dir" 2>/dev/null || fail '另一更新任务已开始，请稍后重试。'
fi
owns_lock=true
printf '%s\n' "$$" > "$lock_dir/pid"

# Only parse JSON; downloaded JavaScript is never evaluated by the updater.
json_value() {
  osascript -l JavaScript -e '
function run(a) {
  var x = JSON.parse(a[1]);
  if (a[0] === "sha") {
    var sha = x && x.object && x.object.sha;
    if (!/^[a-f0-9]{40}$/.test(sha || "")) throw Error("Invalid GitHub commit");
    return sha;
  }
  if (x.manifest_version !== 3 || ["AI Memory Collector · P0", "AI Memory Collector"].indexOf(x.name) < 0 ||
      x.background.service_worker !== "background.js" || x.options_ui.page !== "panel.html")
    throw Error("Not an AI Memory Collector extension");
  if (typeof x.version !== "string" || !/^\d+(\.\d+){0,3}$/.test(x.version) ||
      x.version.split(".").some(function (v) { return Number(v) > 65535; }))
    throw Error("Invalid extension version");
  var key = x.key === undefined ? "" : x.key;
  if (typeof key !== "string" || !/^[A-Za-z0-9+/=]*$/.test(key)) throw Error("Invalid extension key");
  return x.version + "|" + key;
}' "$1" "$2"
}

manifest_info() {
  local folder=$1
  [ -f "$folder/manifest.json" ] && [ ! -L "$folder/manifest.json" ] || return 1
  [ "$(wc -c < "$folder/manifest.json")" -le 65536 ] || return 1
  json_value manifest "$(cat "$folder/manifest.json")"
}

validate_files() {
  local folder=$1 item scan
  for item in manifest.json background.js panel.html; do
    [ -f "$folder/$item" ] && [ ! -L "$folder/$item" ] || return 1
  done
  if [ "${2:-}" = complete ]; then
    for item in panel.js bootstrap.js panel.css lib/archive.js lib/chatgpt.js lib/github.js lib/storage.js; do
      [ -f "$folder/$item" ] && [ ! -L "$folder/$item" ] || return 1
    done
  fi
  scan=$(find "$folder" ! -type f ! -type d -print -quit) || return 1
  [ -z "$scan" ] || return 1
  # Archive/data directories and developer checkouts must never be replaced.
  scan=$(find "$folder" -type d \( -name p0-captures -o -name data -o -name archives -o -name .git -o -name private \) -print -quit) || return 1
  [ -z "$scan" ] || return 1
}

if [ "$mode" != choose ] && [ -f "$state_dir/target-path" ]; then
  target_dir=$(cat "$state_dir/target-path")
else
  printf '请选择浏览器原来加载的 extension 文件夹，不要选择对话保存目录。\n'
  target_dir=$(osascript -e 'POSIX path of (choose folder with prompt "选择浏览器原来加载的 AI Memory Collector extension 文件夹（不要选择对话数据目录）")') || fail '未选择目录；没有修改插件。'
fi
target_dir=${target_dir%/}
if [ ! -f "$target_dir/manifest.json" ] && [ -f "$target_dir/extension/manifest.json" ]; then target_dir="$target_dir/extension"; fi
case "$target_dir" in /*) ;; *) fail '安装目录必须是绝对路径，请用 --choose 重新选择。';; esac
case "$target_dir" in *$'\n'*|*$'\r'*) fail '安装目录不能包含换行符。';; esac
parent_dir=${target_dir%/*}
[ -d "$parent_dir" ] || fail '原安装目录的上级目录不存在，请用 --choose 重新选择。'
[ "$(cd "$parent_dir" && pwd -P)" = "$parent_dir" ] || fail '安装路径含符号链接或不规范路径，请选择实际的原安装目录。'
target_id=$(printf '%s' "$target_dir" | shasum -a 256)
target_id=${target_id%% *}
target_state="$state_dir/$target_id"
mkdir -p "$target_state"
valid_backup_path() {
  [ "${1%/*}" = "$parent_dir" ] || return 1
  case "${1##*/}" in .ai-memory-collector-backup.*) return 0 ;; *) return 1 ;; esac
}
# Persist the planned backup before moving anything. After a crash between the
# two renames, the next run can restore the original at exactly the same path.
if [ -f "$target_state/last-backup.next" ]; then
  interrupted_backup=$(cat "$target_state/last-backup.next")
  valid_backup_path "$interrupted_backup" || fail '上次更新的恢复记录无效，请检查更新工具设置目录。'
  if [ ! -e "$target_dir" ]; then
    [ -d "$interrupted_backup" ] && [ ! -L "$interrupted_backup" ] && manifest_info "$interrupted_backup" >/dev/null && validate_files "$interrupted_backup" || fail "原安装目录缺失，且恢复备份不可用。请检查：$interrupted_backup"
    mv "$interrupted_backup" "$target_dir" || fail "无法恢复原安装目录。原代码仍在：$interrupted_backup"
    rm -f "$target_state/last-backup.next"
    printf '已恢复上次中断更新前的原插件目录。\n'
  elif [ -d "$interrupted_backup" ]; then
    [ ! -L "$interrupted_backup" ] && manifest_info "$interrupted_backup" >/dev/null && validate_files "$interrupted_backup" || fail '上次更新备份不可用，请检查原代码。'
    mv "$target_state/last-backup.next" "$target_state/last-backup"
  else
    rm -f "$target_state/last-backup.next"
  fi
fi
[ -d "$target_dir" ] || fail '原安装目录不存在。请用 --choose 重新选择，不要重新安装到其他目录。'
physical_dir=$(cd "$target_dir" && pwd -P)
[ "$target_dir" = "$physical_dir" ] && [ ! -L "$target_dir" ] || fail '安装路径含符号链接或不规范路径，请选择实际的原安装目录。'
case "$target_dir" in /|"$HOME"|/Applications|/Users|/Library|/System) fail '不能将此目录用作插件安装目录。';; esac
installed_info=$(manifest_info "$target_dir") || fail '所选目录不是受支持的 AI Memory Collector 插件目录。'
validate_files "$target_dir" || fail '插件目录含缺失文件、符号链接或非插件数据。请先将对话数据放到独立目录，再重试。'
printf '%s\n' "$target_dir" > "$state_dir/target-path.next"
mv "$state_dir/target-path.next" "$state_dir/target-path"
installed_version=${installed_info%%|*}
printf '\n原安装目录：%s\n当前版本：%s\n' "$target_dir" "$installed_version"
printf '更新前应已暂停自动任务；有进行中的对话任务先“停止本轮”，并等待独立传输和文件写入结束。\n关闭采集台不会停止任务；本工具不读取浏览器状态，无法确认是否空闲。更新后需要重新加载插件。\n'

stage_dir=$(mktemp -d "$parent_dir/.ai-memory-collector-stage.XXXXXX")
if [ "$mode" = rollback ]; then
  [ -f "$target_state/last-backup" ] || fail '此安装目录还没有更新备份。'
  previous_backup=$(cat "$target_state/last-backup")
  valid_backup_path "$previous_backup" || fail '备份路径无效。'
  [ -d "$previous_backup" ] && [ ! -L "$previous_backup" ] || fail '备份不存在或不是普通目录。'
  source_info=$(manifest_info "$previous_backup") || fail '备份内容无效。'
  validate_files "$previous_backup" || fail '备份文件不完整。'
  ditto "$previous_backup" "$stage_dir"
  printf '准备恢复备份版本：%s\n' "${source_info%%|*}"
else
  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/ai-memory-collector-download.XXXXXX")
  printf '本次更新渠道：%s（测试渠道需每次显式指定 --test）\n' "$channel"
  printf '正在检查 GitHub 上的代码…\n'
  curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 --max-filesize 1048576 \
    --output "$work_dir/ref.json" "https://api.github.com/repos/SmallCream/ai-memory-collector/git/ref/heads/$source_ref" || fail '无法检查 GitHub 版本；原插件未修改。请检查网络或稍后重试。'
  commit_sha=$(json_value sha "$(cat "$work_dir/ref.json")") || fail 'GitHub 返回的版本信息无效；原插件未修改。'
  printf '正在下载代码版本 %.12s…\n' "$commit_sha"
  curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 --max-filesize 52428800 \
    --output "$work_dir/source.zip" "https://codeload.github.com/SmallCream/ai-memory-collector/zip/$commit_sha" || fail '下载失败；原插件未修改。请检查网络后重新运行。'
  archive_root="ai-memory-collector-$commit_sha"
  unzip -Z1 "$work_dir/source.zip" > "$work_dir/entries" || fail '下载文件不是有效的 ZIP；原插件未修改。'
  unzip -Z -l "$work_dir/source.zip" > "$work_dir/attributes" || fail '无法检查 ZIP 文件属性；原插件未修改。'
  awk 'substr($1,1,1)=="l" { bad=1 } END { exit bad ? 1 : 0 }' "$work_dir/attributes" || fail '压缩包包含符号链接；原插件未修改。'
  while IFS= read -r entry; do
    case "$entry" in "$archive_root"/*) ;; *) fail '压缩包目录不符合预期；原插件未修改。';; esac
    case "/$entry/" in *'/../'*|*'/./'*|*'\'*) fail '压缩包包含不安全路径；原插件未修改。';; esac
  done < "$work_dir/entries"
  unzip -q "$work_dir/source.zip" "$archive_root/extension/*" -d "$work_dir/unpacked" || fail '解压失败；原插件未修改。'
  source_dir="$work_dir/unpacked/$archive_root/extension"
  source_info=$(manifest_info "$source_dir") || fail '下载的插件清单无效；原插件未修改。'
  validate_files "$source_dir" complete || fail '下载的插件不完整或包含不支持的文件；原插件未修改。'
  osascript -l JavaScript -e 'function run(a) { var x=a[0].split(".").map(Number), y=a[1].split(".").map(Number); for(var i=0;i<4;i++){ if((x[i]||0)>(y[i]||0))return "ok"; if((x[i]||0)<(y[i]||0))throw Error("Refusing downgrade"); } return "ok"; }' "${source_info%%|*}" "$installed_version" >/dev/null || fail '远端版本低于已安装版本，已停止更新；需要恢复时请使用 --rollback。'
  ditto "$source_dir" "$stage_dir"
fi
[ "${installed_info#*|}" = "${source_info#*|}" ] || fail '新旧插件身份 key 不一致，已停止更新，避免丢失原配置。'
validate_files "$stage_dir" || fail '暂存文件不完整；原插件未修改。'
file_list=$(mktemp "$state_dir/files.XXXXXX")
find "$target_dir" -type f -print0 > "$file_list" || fail '无法完整读取原插件目录，已停止更新。'
while IFS= read -r -d '' existing_file; do
  relative_file=${existing_file#"$target_dir/"}
  case "$relative_file" in
    # Removed in 0.3.24; the complete old directory remains in the backup.
    lib/lfs.js) continue ;;
    manifest.json|background.js|panel.html|panel.js|bootstrap.js|panel.css|lib/archive.js|lib/chatgpt.js|lib/github.js|lib/storage.js|.DS_Store|*/.DS_Store) continue ;;
  esac
  [ -f "$stage_dir/$relative_file" ] || fail '原插件目录包含不属于此更新包的文件。为保护个人数据已停止，请将额外文件移到独立目录后重试。'
done < "$file_list"
rm -f "$file_list"
file_list=''
if diff -qr -x .DS_Store "$target_dir" "$stage_dir" >/dev/null; then
  printf '\n已是相同代码，无需更新。安装目录和配置保持原样。\n'
  exit 0
fi

# Stage beside the target so directory renames stay on the same filesystem.
# Keep every prior code snapshot; never delete an earlier backup automatically.
backup_dir=$(mktemp -d "$parent_dir/.ai-memory-collector-backup.XXXXXX")
rmdir "$backup_dir"
printf '%s\n' "$backup_dir" > "$target_state/last-backup.next"
replacing=true
mv "$target_dir" "$backup_dir"
mv "$stage_dir" "$target_dir"
stage_dir=''
replacing=false
if ! mv "$target_state/last-backup.next" "$target_state/last-backup"; then
  printf '\n代码已更新，但备份位置记录保存失败；请保留这个路径用于手动恢复：%s\n' "$backup_dir" >&2
fi
printf '\n完成：%s → %s\n原安装目录保持不变：%s\n原代码备份：%s\n' "$installed_version" "${source_info%%|*}" "$target_dir" "$backup_dir"
printf '\n接下来：\n1. 打开 chrome://extensions（Edge 使用 edge://extensions）。\n2. 找到 AI Memory Collector，点击“重新加载”。\n3. 刷新来源平台页，关闭旧采集台，再点击扩展图标打开。\n4. 核对版本、账号和保存目录，按更新前记录恢复需要的自动开关。已停止的账号需主动“检查更新”开始新一轮。\n不要卸载或换目录重新安装。此脚本不读取或修改浏览器中的 Token、设置和对话数据。\n'
