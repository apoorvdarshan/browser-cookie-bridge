#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
icon_work="$project_dir/work/AppIcon.iconset"
source_svg="$project_dir/macos-app/Resources/AppIcon.svg"
output_icns="$project_dir/macos-app/Resources/AppIcon.icns"

mkdir -p "$icon_work"
sips -s format png "$source_svg" --out "$icon_work/icon_512x512@2x.png" >/dev/null

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$icon_work/icon_512x512@2x.png" --out "$icon_work/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  sips -z "$double_size" "$double_size" "$icon_work/icon_512x512@2x.png" --out "$icon_work/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$icon_work" -o "$output_icns"
