# Verification — 8 October 2026

## Passed
- Seventeen automated checks passed using `npm test` after the growing queue and SignalDeck update.
- Metadata parsing: Arabic names, comma-containing groups, relative media/logo URLs, provider HTTP headers, duplicate streams, unsupported URLs, leading comments, and plain M3U entries.
- HLS handling: manifests stay a single stream; nested segments and encryption-key URLs are rewritten through the local relay.
- A generated 10,000-channel playlist parsed with the correct count.
- Integration workflow: saving sources made no network requests; explicit fetching loaded channels; duplicates across sources retained source membership.
- Real HLS and MP4 fixtures decoded video frames at 640×360 with H.264 metadata and saved previews.
- A missing stream and an HTML response were classified as failed media checks.
- HTTP range relay, HLS segment relay, and fragmented MP4 compatibility conversion passed.
- Cancellation stopped a hanging fetch. New requests joined the active queue; pending duplicates were skipped. Source edits during fetching were rejected.
- Failed refresh preserved previously loaded channels.
- Favorites, stream-test results, and channels survived a server restart.
- Provider token text was absent from ordinary state responses and exported reports; foreign-origin requests were rejected.
- Padded source inputs, padded replacement URLs, and padded relative channel URLs retained the same result. Encoded URL query values remained intact; percent-encoded labels, Arabic, and HTML entities became readable.
- Mixed prose, Markdown links, tables, duplicate links, backup file suffixes, provider endpoints, HTML ampersands and punctuation passed URL extraction checks. GitHub file URLs became raw URLs; GitHub folder URLs and unrelated inline links were ignored. The integration check saved exactly two sources from mixed text without making network requests.
- Automatic decoding after an explicitly requested fetch passed. Known MP4 responses reported their format without requiring a preliminary sniff request.
- Navigation checks passed for next/previous wraparound, failed-stream exclusion, shuffle avoiding the current channel, and empty/single-channel filters.
- Isolated browser verification confirmed automatic sample checks after fetching, Next and Shuffle switching between good samples while skipping failures, and an untested transport-stream sample disguised as MP4 automatically falling back to converted playback. Converted video rendered at 1280×720 with no media error, while the playback selector remained Auto.
- Browser inspection showed completed tests with two decoded and two failed fixture streams. MP4, HLS, and compatibility-mode playback displayed actual video. Converted playback reported 1280×720 without a media error. The browser error log was empty at the inspection point.
- `start.bat` was tested both with the server stopped and with a server already running. Cold launch started the service and opened the player; a repeated launch opened the existing instance.
- Final live UI remained usable while the user's own source loaded 10,125 unique channels. These real provider channels were untested at the captured moment; loading them does not establish their playback availability.

## Evidence and limits
SignalDeck queue verification covered appending work during a running batch, shared concurrency limits, increasing parallelism while running, deduplication, cancellation, and persisted speed/timeout settings. Browser verification loaded and decoded two new playlists while a previous source was still waiting; results appeared directly on channel cards. Test all channels queued four checks while a search displayed only one channel. MP4 playback rendered 640×360 with no media error, and the inspected browser error log was empty. The Activity & results section is removed. New branding and favicon were visible; screenshot: `test-output/signaldeck-ready.png`.
Selected deletion preserved unselected sources; Undo merged the deleted selection back. Tagged saved collections survived delete-all and server restart, restored loaded channels, and skipped duplicate URLs on repeated loading. The isolated browser saved one of two checked playlists under a tag, deleted only that selection, cleared the remaining library, then loaded the preserved playlist successfully. Screenshot: `test-output/selected-and-preserved.png`.
Delete-all verification passed during concurrent fetch and media checks: work was cancelled before clearing, and cancelled tasks did not restore old channels. Undo restored the sources, channels, favorites and checks after a server restart. The isolated browser cleared two playlists in one click and restored both using Undo delete; screenshot: `test-output/delete-all-ready.png`.

Whole-page import was verified in an isolated browser: two unique playlists were found among notes, table text, Markdown and a duplicate; both loaded successfully. Copying HTML with playlist links labeled Germany and Austria also detected both target URLs while excluding a notes-page hyperlink. A 10,000-line extraction produced 200 unique links in 19 ms on this computer.

Generated test media and isolated test libraries are retained in `test-output/`. The final interface screenshot is `test-output/player-ready.png`. User data remains in `data/`.

Playback verification used generated local samples, not the user's provider channels. Results are snapshot checks, not long-term stability measurements. Provider restrictions and protected content still apply. A mobile device and external VLC installation were not tested.
