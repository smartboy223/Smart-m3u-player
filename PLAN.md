# Smart M3U Player — proposed build

## Outcome
A local Windows application for adding multiple M3U playlist URLs, fetching them only when requested, comparing their contents and stream quality, and watching available channels comfortably. Provide a Windows launcher and a setup guide.

## Workflow
1. Paste one or many playlist URLs, one per line. Name each source and save it locally. Saving does not contact the source.
2. Select sources and press **Fetch & Load**. Show source-level progress, channel totals, warnings, retries, and a Cancel button. Preserve the previous successful library if a refresh fails.
3. Browse channels in a searchable library with source, category, language where supplied, logo, and favorites. Identify duplicate stream URLs while preserving their source memberships. Do not guess missing metadata.
4. Press **Test selected** or **Test all** to begin a bounded background quality check. Test streams individually with limited concurrency, timeouts, cancellation, and conservative retries. Never open every channel simultaneously.
5. Filter by working, failed, untested, or inconclusive status; compare sources and inspect each result. Export a report.
6. Select a channel and press Play. Offer fullscreen, volume, mute, keyboard controls, fit/aspect controls, available quality selection, and retry/reconnect with a visible state. Retain library navigation alongside the player.

## What testing reports
- Playlist retrieval success, fetch time, number of entries, and parsing warnings.
- Reachability and response time for each tested stream.
- Whether a manifest/media sample can actually be read and decoded; a successful HTTP response alone is insufficient proof of playback.
- Codec, resolution, frame rate, and bitrate when available. Distinguish declared values from measured values and leave unavailable fields empty.
- Short sample observations, such as startup delay and detected errors. Label these as a snapshot rather than a guarantee of ongoing reliability.
- Useful failure explanations, including timeout, expired link, access denied, unsupported media, and unavailable stream.
- Channel names and categories supplied by the playlist. Optional thumbnails from readable video samples help inspect content; do not claim automated understanding of everything broadcast.

## Reliability and local operation
- Local service and browser interface bound to the local machine by default; persist sources, last successful channel libraries, favorites, settings, and test history locally.
- A local media relay handles browser restrictions for supported streams. Validate HTTP/HTTPS inputs, limit redirects and response sizes, and handle relative playlist/media URLs correctly.
- Inspect the available media tools during setup. Use a media probe for deeper checks and consider an on-demand conversion path for codecs the browser cannot play. Surface missing dependencies clearly.
- Treat URLs with tokens as credentials: avoid including them in ordinary logs and exported reports. Redact sensitive URL components in the interface, with a deliberate reveal/copy action.
- Prevent overlapping jobs for the same source. Show accurate queued/running/succeeded/failed counts, elapsed time, and reasons for stalled work.
- Long playlists load progressively with a virtualized channel list. Fetching, testing, and playing remain separate user actions.
- Provide an external-player fallback for formats the browser cannot handle. Protected streams, provider restrictions, geographic blocks, expired credentials, and inaccessible sources may remain unavailable.
- No scheduled refresh or automatic stream testing by default.

## Interface
Dark viewing-friendly layout with Sources, Channels, Tests, and Settings. Support Arabic channel names and bidirectional text. Show a persistent player, source/category filters, search, favorites, recent viewing, and an understandable activity panel.

## Delivery and verification
1. Build source management, robust parsing, persistence, and explicit fetch jobs.
2. Build channel browsing and playback, including supported media relay paths.
3. Add explicit quality tests, source comparison, history, and report export.
4. Add Windows setup/launch scripts and clear dependency guidance.
5. Verify multiline input, malformed and empty playlists, relative URLs, duplicate entries, Arabic names, refresh failure recovery, timeout/cancel behavior, job counts, token redaction, restart persistence, and large-library usability.
6. Verify real playback controls and stream checking with controlled working and failing fixtures. Once the user supplies URLs, test those URLs separately and report their actual availability without treating fixtures as proof of provider compatibility.

## Approval
Implementation begins after approval of this plan, following the user's saved preference for planning new systems first. Recommended default: local Windows operation with manual Fetch & Load and manual stream testing.
