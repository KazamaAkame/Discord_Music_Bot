# Discord Music Bot (YouTube + Spotify metadata resolver)

This project uses `discord.js`, `@discordjs/voice`, and `play-dl`.

- Song name input: searches YouTube and plays the first result.
- YouTube URL input: plays a video or queue from a playlist.
- Spotify URL input (`track`, `album`, `playlist`): resolves metadata with Spotify API, then finds playable YouTube matches.

## 1. Install

```bash
npm install
```

## 2. Create environment file

Copy `.env.example` to `.env` and fill values:

```env
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
```

- If `DISCORD_GUILD_ID` is set, slash commands appear quickly in that guild.
- Without `DISCORD_GUILD_ID`, commands are global and can take up to about 1 hour to appear.

### Optional: Spotify URL support (advanced)

Spotify playlist support requires OAuth authorization, callback handling, tester/account access setup, and permission alignment.
Use it when needed, but for day-to-day playback, YouTube / YouTube Music playlists are usually simpler and more stable.

Add:

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_MARKET=US
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/spotify/callback
SPOTIFY_OAUTH_SCOPES=playlist-read-private playlist-read-collaborative
```

Then in Spotify Developer Dashboard:
- Open your app -> `Edit settings`
- Add the same callback URI in `Redirect URIs`:
  - `http://127.0.0.1:8787/spotify/callback`
- Save settings.
- If your app is still in development mode, also add testers in `Users and Access` (otherwise those Spotify accounts will get API 403: "not registered for this application").

For Spotify playlists that require user auth:
1. Run `/spotifylogin` in Discord.
2. Click the auth link and approve Spotify access.
3. If browser shows `127.0.0.1 ... connection refused`, copy the full URL from the address bar.
4. Run `/spotifycallback callback_url:<that full URL>` in Discord.
5. Then use `/play <spotify playlist url>`.

## 3. Run

```bash
npm run start
```

## Quick Git Sync (one command)

You can auto-run `git add + commit + push` with:

```powershell
.\sync.ps1
```

Optional custom commit message:

```powershell
.\sync.ps1 -Message "feat: update music bot"
```

Or use npm shortcut:

```bash
npm run sync
```

## 4. Discord developer setup

In Discord Developer Portal:

1. Go to `Bot` page.
2. Go to `OAuth2 > URL Generator`.
3. Select scopes: `bot`, `applications.commands`.
4. Select permissions at least:
- `Connect`
- `Speak`
- `Send Messages`
- `View Channels`
5. Use generated invite URL to add bot to your server.

## 5. Commands

- `/play query:<song name or URL>`
- `/skip`
- `/pause`
- `/resume`
- `/queue`
- `/clearupcoming` (clear all upcoming tracks, keep now playing)
- `/spotifylogin` (authorize Spotify playlist access)
- `/spotifycallback callback_url:<full callback url>` (finish Spotify authorization from any device)
- `/spotifylogout` (remove your Spotify auth)
- `/list` (progress bar + upcoming tracks)
- `/stop`
- `/leave`
- `/panel` (interactive button UI for mobile/desktop)

## Notes

- Spotify API does not provide direct audio streaming here; this bot only uses Spotify metadata and then plays YouTube matches.
- Spotify single-track links are usually the most reliable Spotify input mode in this bot.
- Loudness balancing is enabled by default (`dynaudnorm + alimiter`). You can tweak it with `ENABLE_AUDIO_NORMALIZER` and `AUDIO_FILTER_CHAIN` in `.env`.
- Large queue/playlist limits are configurable in `.env` (`MAX_QUEUE_LENGTH`, `MAX_YOUTUBE_PLAYLIST_TRACKS`, `MAX_SPOTIFY_TRACKS`).
  - Current recommended max for Spotify import is `MAX_SPOTIFY_TRACKS=9999` (very large playlists can take longer to resolve).
- Spotify large-playlist import tuning:
  - `SPOTIFY_SEARCH_CONCURRENCY` (default `6`): parallel YouTube matching workers.
  - `SPOTIFY_PROGRESS_EVERY` (default `25`): update progress every N processed tracks.
  - `SPOTIFY_PROGRESS_MIN_INTERVAL_MS` (default `2000`): minimum interval between progress message edits.
- If Spotify returns `403 Forbidden` on playlist items, the authorized account likely lacks access to that playlist (owner/collaborator/private visibility issue).
- In practice, Spotify playlist integration is more operationally complex than YouTube playlist playback. If your use case does not strictly require Spotify links, using YouTube / YouTube Music is recommended.
- `/list` shows a compact upcoming preview (default 10 tracks) and also displays total queued count.
- Use this bot in compliance with Discord, YouTube, and Spotify terms.
