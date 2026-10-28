# mod8 Social upgrade: plan (2026-10-28)

Goal: one tool inside mod8 that runs Instagram/Facebook for our own brands (Safer, SleepWell, Hotel-Agents, Keler, DataRate, Stay Innovation):
draft -> Yonatan approves -> post now or at a set time -> stats back. No outside service gets our logins.

## Today
- Posting works, but through side scripts (scratchpad ig-video.py / ig-publish.py) with the "mod8 Social-IG" app token.
- src/loop/adapters/meta.ts (185 lines) only speaks graph.facebook.com (Page tokens). The Instagram-Login path we actually use is NOT in mod8.
- Video hosting = GitHub Pages repo safer-social-preview, needs a gh account switch every time.
- Safer IG token is 60-day, expires ~2026-12-21. Nothing refreshes it.

## Build, in order (each step usable on its own)
1. [DONE 0828fd3] **Instagram-Login in meta.ts**: graph.instagram.com publish for photo, carousel, reel, story; wait for video processing; per-brand token in products/<slug>/connectors/meta.json (0600). Retire the side scripts.
2. [DONE 0828fd3] **Token never dies**: auto-refresh the IG long-lived token (refresh_access_token endpoint) every 30 days + warning 10 days before expiry if refresh fails.
3. [DONE 10-28] **Media hosting inside mod8**: upload the mp4/png to mod8 static hosting (*.apps.mod8.ai) to get the public URL Instagram needs. No GitHub switch.
4. [DONE 10-28: `mod8 social draft`] **Draft -> approve -> post**: social_draft / social_publish tools wired through the existing approval Panel. Nothing posts without an approve. Shows caption, media preview, reel/story/feed, brand.
5. **Schedule**: queue with a publish time per post; mod8 loop (on the VPS, not his Mac) posts it on time; suggest best hour from step 6 data.
6. **Stats**: pull insights per post (views, reach, likes, comments, shares, saves, follows) daily; weekly one-screen report per brand: what worked, what didn't, what to post next.
7. **Know-how (no outside API)**: borrow the best free ideas from public skill packs (hooks, caption formulas, content calendar) as mod8 prompt files, read-only.

## Not doing
- No third-party schedulers (Metricool, Blotato, PostBridge...): they would hold our tokens; cost monthly.
- No customer/SaaS connect (decision 2026-10-22: own brands first) -> no Meta App Review needed.
- No AI video spend from mod8 without an explicit yes to a stated amount.

## Size
Steps 1-3 ~1 day, step 4 ~1 day, steps 5-6 ~1-2 days, step 7 ~half day. Each step gets behavior specs (specs/behavior/) and one real test post to a test account before Safer.
