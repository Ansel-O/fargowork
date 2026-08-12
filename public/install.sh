#!/usr/bin/env sh
set -eu

target=all
version=0.5.0-rc.1
local_dir=
release_base=${FARGOWORK_RELEASE_BASE_URL:-}
dry_run=0
jsonl=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) target=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --local-artifact-dir) local_dir=$2; shift 2 ;;
    --release-base-url) release_base=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --output=jsonl) jsonl=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$release_base" ]; then
  release_base="https://github.com/Ansel-O/fargowork/releases/download/v${version}"
fi

case "$target" in all|workbuddy|codex|cursor) ;; *) echo "invalid target" >&2; exit 2 ;; esac
platform_name=linux
arch_name=x64
case "$(uname -s)" in Darwin) echo "macOS native Keychain support is not included in this release; no installation was performed" >&2; exit 4 ;; Linux) platform_name=linux ;; *) echo "unsupported platform" >&2; exit 2 ;; esac
case "$(uname -m)" in x86_64|amd64) arch_name=x64 ;; arm64|aarch64) arch_name=arm64 ;; *) echo "unsupported architecture" >&2; exit 2 ;; esac

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/fargowork-install.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT INT TERM

fetch() {
  name=$1
  if [ -n "$local_dir" ]; then
    path=$local_dir/$name
    [ -f "$path" ] || { echo "local artifact missing: $name" >&2; exit 4; }
    printf '%s\n' "$path"
    return
  fi
  [ -n "$release_base" ] || { echo "remote Release unavailable: pass --local-artifact-dir or --release-base-url; this checkout claims no public URL" >&2; exit 4; }
  case "$release_base" in *example.invalid*) echo "remote Release URL is a placeholder and unavailable" >&2; exit 4 ;; esac
  case "$release_base" in https://*) ;; *) echo "remote Release URL must use HTTPS" >&2; exit 4 ;; esac
  path=$tmp_dir/$name
  curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$release_base/${name}" -o "$path"
  printf '%s\n' "$path"
}

checksum_file=$(fetch SHA256SUMS)
validate_checksums() {
  awk '
    NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-f]+$/ || $2 ~ /(^|[\\/])\.\.([\\/]|$)/ || $2 ~ /^([A-Za-z]:)?[\\/]/ || seen[$2]++ { invalid = 1 }
    END { if (NR == 0 || invalid) exit 1 }
  ' "$checksum_file" || { echo "invalid SHA256SUMS format" >&2; exit 4; }
}
validate_checksums
read_checksum() { awk -v name="$1" '$2 == name {print $1}' "$checksum_file"; }
verify() {
  name=$1
  path=$2
  expected=$(read_checksum "$name")
  [ "${#expected}" -eq 64 ] || { echo "checksum subject missing: $name" >&2; exit 4; }
  actual=$(sha256sum "$path" | awk '{print $1}')
  [ "$actual" = "$expected" ] || { echo "SHA256 mismatch: $name" >&2; exit 4; }
}

assert_safe_zip() {
  archive=$1
  command -v zipinfo >/dev/null 2>&1 || { echo "zipinfo is required for ZIP safety checks" >&2; exit 4; }
  while IFS= read -r name; do
    case "$name" in
      ''|/*|../*|*/../*|..|*/..|*\\*|*:* ) echo "unsafe ZIP path: $name" >&2; exit 4 ;;
    esac
  done <<EOF
$(unzip -Z1 "$archive")
EOF
  if zipinfo -l "$archive" | awk 'NR > 3 && substr($1, 1, 1) == "l" { found = 1 } END { exit found ? 0 : 1 }'; then
    echo "ZIP symlinks are not allowed" >&2
    exit 4
  fi
}

cli_name="fargowork-cli-v${version}-${platform_name}-${arch_name}.zip"
bridge_name="fargowork-bridge-v${version}-${platform_name}-${arch_name}.zip"
plugin_name="fargowork-agent-plugin-v${version}-${platform_name}-${arch_name}.zip"
cli_zip=$(fetch "$cli_name")
bridge_zip=$(fetch "$bridge_name")
plugin_zip=$(fetch "$plugin_name")
verify "$cli_name" "$cli_zip"
verify "$bridge_name" "$bridge_zip"
verify "$plugin_name" "$plugin_zip"
if [ "$dry_run" -eq 1 ]; then
  if [ "$jsonl" -eq 1 ]; then printf '%s\n' '{"event":"dry_run","status":"verified","installed":false,"connected":false,"trusted":"unknown","needs_user_action":true}'; else echo 'artifacts verified; no files changed'; fi
  exit 0
fi

command -v unzip >/dev/null 2>&1 || { echo "unzip is required for local artifact installation" >&2; exit 4; }
mkdir -p "$tmp_dir/cli" "$tmp_dir/plugin"
assert_safe_zip "$cli_zip"
assert_safe_zip "$bridge_zip"
assert_safe_zip "$plugin_zip"
unzip -q -o "$cli_zip" -d "$tmp_dir/cli"
unzip -q -o "$plugin_zip" -d "$tmp_dir/plugin"
cli_bin=$(find "$tmp_dir/cli" -type f -name fargowork | head -n 1)
[ -n "$cli_bin" ] || { echo "CLI artifact is missing fargowork" >&2; exit 4; }
plugin_source=$tmp_dir/plugin/fargowork
[ -f "$plugin_source/plugin.json" ] || { echo "Plugin artifact is missing plugin.json" >&2; exit 4; }

install_root=${XDG_CONFIG_HOME:-$HOME/.config}/fargowork
bin_dir=$install_root/bin
plugin_dest=$install_root/plugin/fargowork
stage=$tmp_dir/stage
mkdir -p "$stage/bin" "$stage/plugin"
cp "$cli_bin" "$stage/bin/fargowork"
cp -R "$plugin_source" "$stage/plugin/fargowork"
cp "$cli_bin" "$stage/plugin/fargowork/bin/fargowork"
printf 'fargowork-owned-v1\n' > "$stage/plugin/fargowork/.fargowork-owner"
# The portable package uses the Windows launcher token for the cross-platform
# Agent Plugin source. Linux installs finalize the same plugin-owned config to
# the native extensionless executable before the plugin becomes usable.
sed -i.bak 's#\./bin/fargowork\.cmd#./bin/fargowork#g' "$stage/plugin/fargowork/mcp.json"
rm -f "$stage/plugin/fargowork/mcp.json.bak"
mkdir -p "$install_root/plugin"
backup=$tmp_dir/backup
mkdir -p "$backup"
if [ -e "$plugin_dest" ]; then
  [ -f "$plugin_dest/.fargowork-owner" ] || { echo "refusing to overwrite non-FargoWork plugin" >&2; exit 4; }
fi
rollback() { rm -rf "$bin_dir" "$plugin_dest"; [ -e "$backup/bin" ] && mv "$backup/bin" "$bin_dir" || true; [ -e "$backup/plugin" ] && mkdir -p "$(dirname "$plugin_dest")" && mv "$backup/plugin" "$plugin_dest" || true; }
if [ -d "$bin_dir" ]; then mv "$bin_dir" "$backup/bin"; fi
if [ -e "$plugin_dest" ]; then mv "$plugin_dest" "$backup/plugin"; fi
if ! { mv "$stage/bin" "$bin_dir" && mkdir -p "$(dirname "$plugin_dest")" && mv "$stage/plugin/fargowork" "$plugin_dest"; }; then rollback; echo "atomic install failed and was rolled back" >&2; exit 4; fi
chmod 700 "$bin_dir/fargowork"
if ! "$bin_dir/fargowork" install --target "$target" --output=jsonl; then rollback; echo "FargoWork post-install failed; previous owned installation was restored" >&2; exit 4; fi
doctor_exit=0
"$bin_dir/fargowork" doctor --target "$target" --output=jsonl || doctor_exit=$?
if [ "$doctor_exit" -ne 0 ] && [ "$doctor_exit" -ne 3 ]; then rollback; echo "FargoWork doctor failed; previous owned installation was restored" >&2; exit 4; fi
if [ "$doctor_exit" -eq 0 ]; then
  if [ "$jsonl" -eq 1 ]; then printf '%s\n' '{"event":"installed","status":"ready","installed":true,"connected":true,"trusted":true,"needs_user_action":false}'; else echo "FargoWork installed and ready for $target"; fi
else
  if [ "$jsonl" -eq 1 ]; then printf '%s\n' '{"event":"installed","status":"needs_user_action","installed":true,"connected":false,"trusted":"unknown","needs_user_action":true}'; else echo 'FargoWork installed; complete login and WorkBuddy UI trust/enable if used'; fi
fi
