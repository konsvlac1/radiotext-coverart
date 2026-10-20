# RadioText Cover Art — Plugin for FM-DX-Webserver

Shows cover art for the song that's currently playing, detected from the
station's RDS data. A default picture is shown whenever no song is
identified.

Based on RadioText Cover Art 1.3.1 by istvn
([DitraXp/radiotext-coverart](https://github.com/DitraXp/radiotext-coverart)).
Version 2.x adds a full settings panel, server-wide defaults, more cover
placements, a RadioText background, a third artwork source and better
handling of Greek RDS.

## Features

- **Song detection from RadioText (RT)** — understands `Artist - Title` and
  `Title - Artist`, ignores prefixes like `Now: `, and copes with RT that
  repeats the song several times.
- **Multiple artists** — `A/B/C`, `A & B`, `A feat. B` etc. are searched by
  the lead artist plus the title.
- **PS fallback** — if a station sends no usable RT but scrolls the song in
  its 8-character PS ("dynamic PS"), the plugin assembles the PS chunks and
  searches for the song.
- **Three artwork sources** — Apple Music (iTunes Search API), then Deezer,
  then MusicBrainz / Cover Art Archive. All are free and need no API key.
- **Greek RDS** — Greek names are matched against the Greeklish names the
  stores use, including RT in capitals that spells Greek by letter shape
  (`ELENH FOYREIRA` → Eleni Foureira) and RT in Greek letters. The Greek
  iTunes store is searched for these.
- **Junk filter** — RT and PS that are clearly not a song are not looked
  up: phone numbers (`T 2641151352 ARTIST - TITLE` keeps the song part),
  e-mail and web addresses, frequencies (`97.8`), ad markers like `SPOT`,
  the same text on both sides of the dash, and scrolling station names.
- **Cover placement** — below the AF list (phones: a panel after
  RADIOTEXT), inside the RadioText panel, inside the PS panel, or floating
  in a corner of the window. Side, size and gap are adjustable.
- **RadioText background** — the cover is shown across the whole
  RadioText panel, blurred (default) or sharp.
- **Info card** — tap the cover for a larger picture with title, artist,
  album and year, plus YouTube and Spotify search buttons and a link to the
  song on Apple Music, Deezer or MusicBrainz.
- **History** — the last 10 detected songs with cover, time and frequency.
- **Per-station settings** — RT order (auto, Artist - Title, Title - Artist)
  and PS mode (default, always, never), remembered by PI code.

## Settings

The ♫ button on the cover (on desktop it appears when you hover over the
cover) opens the settings panel. A listener's changes are stored in their
browser and apply only there; everything they don't change follows the
server's defaults. Settings changed from the defaults are marked •, and
**Reset to server defaults** undoes them.

When you are logged in as admin on the page, the panel shows **Save as
server defaults**, which makes the settings shown the defaults for every
listener (per-station settings stay personal).

| Setting | Default | What it does |
|---|---|---|
| Enable cover art | on | Turns the plugin on or off |
| Cover placement | Below AF list | Below AF list, inside RadioText panel, inside PS panel, or floating corner |
| Side / Corner | Right | Which side of the panel (or bottom corner) the cover sits on |
| Size (px) | 100 | Cover size (below AF list: minimum size) |
| Gap (px) | 8 | Space around the cover |
| RadioText background | Blurred cover | Cover across the RadioText panel: blurred, sharp, or off |
| Cover backdrop | None | Blurred cover behind the cover box (or behind the PS panel) |
| Blur amount (px) | 12 | Blur of the background and backdrop |
| Caption on hover | on | Artist and title over the cover on hover |
| Keep last cover during jingles / news | off | Keeps the last cover until the next song instead of the default picture |
| Song information source | RT + PS fallback | RT + PS fallback, RadioText only, or PS only |
| RT delay (ms) | 2500 | How long RT must stay unchanged before it is looked up |
| Title detection strictness | Normal | Loose, Normal or Strict matching of the found song |
| Retry if no artwork | on | When nothing was found, asks again after 30 seconds and once more 90 seconds later |
| iTunes / Deezer / MusicBrainz | on | Which artwork sources to use |
| Keep found covers for 7 days | on | Keeps found covers in the browser |
| Debug logging | off | Logs detection and lookups to the browser console |

## Install / update

1. Stop your fm-dx-webserver.
2. Delete the existing `radiotext-coverart.js` file and `radiotext-coverart/`
   folder from your `plugins/` folder.
3. Copy these into `plugins/`, keeping the structure:
   ```
   plugins/
     radiotext-coverart.js
     radiotext-coverart/
       radiotext-coverart.js
       radiotext-coverart_server.js
   ```
   (`README.md` doesn't need to be copied — it's just documentation.)
4. Start the webserver. You should see a console line like:
   `Plugin RadioText Cover Art 2.1 initialized successfully.`
5. Make sure it's enabled under admin **Settings → Plugins**.
6. Restart the webserver once more (server-side scripts load at startup)
   and reload the page in your browser (Ctrl+F5).

Settings saved by 1.3.x (on/off and song source) are carried over.

## Server defaults file

On first start the plugin creates
`plugins_configs/radiotext-coverart.json`. **Save as server defaults**
writes it; you can also edit it by hand and restart the webserver.

```json
{
  "providers": { "itunes": true, "deezer": true, "musicbrainz": true },
  "defaultImage": null,
  "defaults": { "placement": "af", "rtBackground": "blur", "...": "..." }
}
```

- `providers` — set a source to `false` to turn it off for everyone.
- `defaultImage` — picture shown when no song is identified. `null` uses
  the built-in placeholder. To use your own, drop an image under the
  webserver's `web` folder (for example `web/images/my-default-cover.png`)
  and set `"/images/my-default-cover.png"`.
- `defaults` — the settings from the table above, as saved by the panel.

## Notes

- Detection depends on what the station broadcasts. Jingles, news and ads
  that don't look like `Artist - Title` are ignored; a song that none of the
  sources knows shows the default picture.
- The PS fallback needs the PS to cycle through at least two different
  frames and the cycle to repeat once, so it takes a few seconds longer than
  RT detection.
- Results are cached on the server (found: 1 hour, not found: 10 minutes).
  Listeners asking for the same song at the same time share one lookup.
- MusicBrainz is queried at most once per second, as its rules require.
- While the settings panel or info card is open, keys don't reach the
  page's tuning shortcuts (arrow keys, B, R).
- The server needs outbound internet access to `itunes.apple.com`,
  `api.deezer.com`, `musicbrainz.org` and `coverartarchive.org`.

## Uninstall

Disable it in **Settings → Plugins**, stop the server, then delete
`radiotext-coverart.js` and the `radiotext-coverart/` folder from
`plugins/`. You can also delete `plugins_configs/radiotext-coverart.json`.

## Changelog

**2.1**
- RadioText background: the cover across the RadioText panel (on by default).
- Greek RDS matching and Greeklish search; Greek iTunes store.
- Junk filter for phone numbers, e-mail/web addresses, frequencies, ad
  markers and scrolling station names.
- Songs that weren't found are not looked up again for 10 minutes.
- Settings panel in two columns with fixed buttons; works with the page's
  button styles; keys typed in it no longer tune the radio.

**2.0**
- Settings panel with per-browser settings over server defaults; admins can
  save server defaults.
- Cover placement inside the RadioText or PS panel, or floating.
- MusicBrainz / Cover Art Archive as a third source.
- Strictness, retry, keep last cover, caption on hover, blurred backdrop,
  per-station RT order and PS mode, 7-day browser cache, debug logging.
