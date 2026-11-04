# HexTV

Watch movies together, in sync. Private repo.

| Folder | What it is | Deployed to |
|---|---|---|
| `site/` | The website (library, rooms, dashboard) | Vercel (`deploy-vercel/public`) |
| `api/` | MovieBox API + video relay (FastAPI) | Vercel (`deploy-vercel/api.py`) |
| `room-server/` | Rooms, chat and stats (Cloudflare Worker + Durable Objects) | Cloudflare |
| `windows/` | Windows app (Electron) | `npm run dist` → installer |
| `android/` | Android app (Capacitor) | `./gradlew assembleRelease` → APK |

Not in this repo on purpose: the Android signing key, the dashboard password, and other secrets.

Each folder is developed in its own working repo next to this one; `./sync.sh` pulls their latest commits in and pushes.
