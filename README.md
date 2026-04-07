<p>
  <a href="https://www.npmjs.com/package/t-get">
    <img alt="tget is wget for torrents" src="https://raw.github.com/FusinX/tget/master/banner.png">
  </a>
</p>

# tget

[tget](https://www.npmjs.com/package/t-get) is wget for torrents — a fast, lightweight CLI torrent client with built-in streaming support.

## Install

```bash
npm install -g t-get
```

## Requirements

Node.js v18 or higher.

## Usage

tget works with a magnet link or a torrent file.

```bash
tget 'magnet:?xt=urn:btih:...'
tget /path/to/file.torrent
```

### Download to a specific directory

```bash
tget 'magnet:?xt=urn:btih:...' -o ~/Downloads
```

### List files inside a torrent without downloading

```bash
tget 'magnet:?xt=urn:btih:...' --list
```

### Download specific files only

Use the index from `--list`:

```bash
tget 'magnet:?xt=urn:btih:...' --select 0,2 -o ~/Downloads
```

### Stream while downloading

Generates an HTTP stream URL you can open in VLC via **Media > Open Network Stream**:

```bash
tget 'magnet:?xt=urn:btih:...' -o ~/Downloads --stream
```

### Stream only (nothing saved to disk)

```bash
tget 'magnet:?xt=urn:btih:...' --stream-only
```

### Auto-open stream in VLC

```bash
tget 'magnet:?xt=urn:btih:...' --stream-only --player vlc
```

### Multiple torrents simultaneously

```bash
tget 'magnet:?xt=urn:btih:AAA...' 'magnet:?xt=urn:btih:BBB...' -o ~/Downloads
```

## All Options

| Flag | Alias | Default | Description |
|---|---|---|---|
| `--path` | `-o` | `.` | Output directory |
| `--connections` | `-c` | `150` | Max peer connections |
| `--trackers` | `-t` | — | Extra tracker URLs (repeatable) |
| `--trackers-auto` | — | `false` | Fetch latest public tracker list on startup |
| `--stream` | `-s` | `false` | Stream while downloading |
| `--stream-only` | `-S` | `false` | Stream only, do not save to disk |
| `--port` | `-p` | `8888` | Stream server port |
| `--prebuffer` | `-b` | `5` | MB to buffer before stream URL appears |
| `--list` | — | `false` | List files in torrent and exit |
| `--select` | — | — | File indices to download e.g. `--select 0,2` |
| `--seed` | — | `false` | Keep seeding after download completes |
| `--seed-ratio` | — | `0` | Stop seeding at this ratio e.g. `1.5` |
| `--download-limit` | — | `0` | Download speed limit in MB/s (0 = unlimited) |
| `--upload-limit` | — | `0` | Upload speed limit in MB/s (0 = unlimited) |
| `--player` | — | — | Auto-open stream in a player e.g. `--player vlc` |
| `--json` | — | `false` | Output status as JSON for scripting |

## Keyboard Controls

While a download is running:

| Key | Action |
|---|---|
| `P` | Pause / resume |
| `Ctrl+C` | Stop and exit |

## JSON Mode

Pipe output into other tools:

```bash
tget 'magnet:?xt=urn:btih:...' --json | jq .
```

Each line is a JSON object:

```json
{"name":"file.mkv","progress":0.42,"speed":3145728,"peers":18,"downloaded":524288000,"total":1258291200}
```

When a stream is ready in JSON mode:

```json
{"event":"stream-ready","name":"file.mkv","url":"http://localhost:8888/<infoHash>/0"}
```

## Streaming Notes

- The stream URL is held back until the prebuffer threshold is reached (default 5MB). This gives VLC a head start and avoids stuttering.
- When VLC connects, tget automatically switches to sequential piece selection so pieces arrive in playback order.
- Range requests are fully supported, so seeking works.
- In `--stream-only` mode, only the largest file in the torrent is fetched to avoid wasting bandwidth.
- Multiple simultaneous streams are supported — each torrent gets its own namespaced route: `http://localhost:<port>/<infoHash>/<fileIndex>`.

## Credits

Built on [WebTorrent](https://github.com/webtorrent/webtorrent). Originally inspired by [peerflix](https://github.com/mafintosh/peerflix) and [jeffjose/tget](https://github.com/jeffjose/tget).

## License

MIT
