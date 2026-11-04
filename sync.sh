#!/bin/sh
# Pull the latest commits from each part's working repo into this one, then push to GitHub.
set -e
cd "$(dirname "$0")"
pull() { git subtree pull -q --prefix="$1" "$2" "$3" -m "Sync $1"; }
pull site        "../streaming platform" master
pull api         ../Moviebox-API         working-playback
pull room-server ../room-server          master
pull windows     ../desktop-app          master
pull android     ../android-app          main
git push origin main
