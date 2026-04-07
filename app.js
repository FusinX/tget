#!/usr/bin/env node

import WebTorrent from "webtorrent";
import { MultiBar, Presets } from "cli-progress";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { exec } from "child_process";
import readline from "readline";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = yargs(hideBin(process.argv))
  .usage("Usage: $0 <magnet-or-torrent> [...] [options]")
  .option("path",           { alias: "o", type: "string",  default: ".",   describe: "Output directory" })
  .option("connections",    { alias: "c", type: "number",  default: 150,   describe: "Max peer connections" })
  .option("trackers",       { alias: "t", type: "array",                   describe: "Extra tracker URLs" })
  .option("stream",         { alias: "s", type: "boolean", default: false, describe: "Stream while downloading" })
  .option("stream-only",    { alias: "S", type: "boolean", default: false, describe: "Stream only, do not save to disk" })
  .option("port",           { alias: "p", type: "number",  default: 8888,  describe: "Stream server port" })
  .option("prebuffer",      { alias: "b", type: "number",  default: 5,     describe: "MB to buffer before announcing stream URL" })
  .option("select",         {             type: "string",                   describe: "File indices to download e.g. --select 0,2" })
  .option("list",           {             type: "boolean", default: false,  describe: "List files in torrent and exit" })
  .option("seed",           {             type: "boolean", default: false,  describe: "Keep seeding after download completes" })
  .option("seed-ratio",     {             type: "number",  default: 0,      describe: "Stop seeding at this ratio e.g. 1.5" })
  .option("download-limit", {             type: "number",  default: 0,      describe: "Download speed limit in MB/s (0 = unlimited)" })
  .option("upload-limit",   {             type: "number",  default: 0,      describe: "Upload speed limit in MB/s (0 = unlimited)" })
  .option("player",         {             type: "string",                   describe: "Auto-open stream in player e.g. --player vlc" })
  .option("json",           {             type: "boolean", default: false,  describe: "Output status as JSON for scripting" })
  .option("trackers-auto",  {             type: "boolean", default: false,  describe: "Fetch latest public tracker list on startup" })
  .help()
  .argv;

const inputs         = argv._;
const streamOnly     = argv["stream-only"];
const streamMode     = streamOnly || argv.stream;
const prebufferBytes = argv.prebuffer * 1024 * 1024;

if (inputs.length === 0) {
  yargs().showHelp();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const bytes = (n = 0) => {
  if (n === 0) return "0 B";
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${["B", "kB", "MB", "GB", "TB"][i]}`;
};

const throttle = (fn, ms) => {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
};

const mimeTypes = {
  ".mkv":  "video/x-matroska",
  ".mp4":  "video/mp4",
  ".avi":  "video/x-msvideo",
  ".mov":  "video/quicktime",
  ".webm": "video/webm",
  ".ts":   "video/mp2t"
};

// ---------------------------------------------------------------------------
// Trackers
// ---------------------------------------------------------------------------
const defaultTrackers = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.openbittorrent.com:6969/announce"
];

async function resolveTrackers() {
  if (argv["trackers-auto"]) {
    try {
      const res  = await fetch("https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt");
      const text = await res.text();
      const list = text.split("\n").map(l => l.trim()).filter(Boolean);
      if (!argv.json) console.log(`Loaded ${list.length} trackers`);
      return list;
    } catch {
      if (!argv.json) console.log("Could not fetch remote trackers — using defaults");
    }
  }
  if (argv.trackers && argv.trackers.length) return argv.trackers;
  return defaultTrackers;
}

// ---------------------------------------------------------------------------
// Global stream server — single instance, routes by /<infoHash>/<fileIndex>
// ---------------------------------------------------------------------------
let streamServer = null;
const torrentMap = new Map();

function ensureStreamServer() {
  if (streamServer) return;

  streamServer = http.createServer((req, res) => {
    const parts    = req.url.split("?")[0].split("/").filter(Boolean);
    const infoHash = parts[0];
    const fileIdx  = parseInt(parts[1] || "0", 10);
    const torrent  = torrentMap.get(infoHash);
    const file     = torrent?.files[fileIdx];

    if (!file) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    file.select();

    const ext      = path.extname(file.name).toLowerCase();
    const mimeType = mimeTypes[ext] || "application/octet-stream";
    const fileSize = file.length;
    const range    = req.headers.range;

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type":   mimeType,
        "Accept-Ranges":  "bytes"
      });
      res.end();
      return;
    }

    let stream;

    if (range) {
      const [s, e] = range.replace(/bytes=/, "").split("-");
      const start  = parseInt(s, 10);
      const end    = e ? parseInt(e, 10) : fileSize - 1;
      res.writeHead(206, {
        "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges":  "bytes",
        "Content-Length": end - start + 1,
        "Content-Type":   mimeType
      });
      stream = file.createReadStream({ start, end });
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type":   mimeType,
        "Accept-Ranges":  "bytes"
      });
      stream = file.createReadStream();
    }

    stream.on("error", () => {});
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });

  streamServer.on("error", err => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${argv.port} already in use. Use --port to pick another.`);
      process.exit(1);
    }
  });

  streamServer.listen(argv.port, () => {
    if (!argv.json) console.log(`Stream server ready on port ${argv.port}`);
  });
}

// ---------------------------------------------------------------------------
// Multi-bar (shared across all torrents)
// ---------------------------------------------------------------------------
const multiBar = new MultiBar({
  format:            "  {name} [{bar}] {percentage}%  {speed}  {peers}  eta {eta}s",
  barCompleteChar:   "=",
  barIncompleteChar: " ",
  clearOnComplete:   false,
  hideCursor:        true,
  autopadding:       true
}, Presets.shades_classic);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const tmpDir      = path.join(os.tmpdir(), `tget-${process.pid}`);
const storagePath = streamOnly ? tmpDir : argv.path;

if (streamOnly) fs.mkdirSync(tmpDir, { recursive: true });

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
const client = new WebTorrent({ maxConns: argv.connections });

client.on("error", err => {
  console.error("Client error:", err.message);
  cleanup();
  process.exit(1);
});

let active = inputs.length;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  const trackers = await resolveTrackers();
  if (streamMode) ensureStreamServer();

  inputs.forEach(input => {
    client.add(input, {
      path:        storagePath,
      announce:    trackers,
      maxWebConns: argv.connections
    }, torrent => onTorrent(torrent));
  });
})();

// ---------------------------------------------------------------------------
// Per-torrent handler
// ---------------------------------------------------------------------------
function onTorrent(torrent) {
  const name = (torrent.name || torrent.infoHash).slice(0, 40);

  if (argv["download-limit"] > 0) torrent.downloadLimit = argv["download-limit"] * 1024 * 1024;
  if (argv["upload-limit"]   > 0) torrent.uploadLimit   = argv["upload-limit"]   * 1024 * 1024;

  // --list: print files and exit
  if (argv.list) {
    console.log(`\n${torrent.name}`);
    torrent.files.forEach((f, i) => console.log(`  [${i}] ${f.name}  (${bytes(f.length)})`));
    torrent.destroy(() => finish());
    return;
  }

  // File selection
  if (argv.select) {
    const selected = new Set(argv.select.split(",").map(Number));
    torrent.files.forEach((f, i) => selected.has(i) ? f.select() : f.deselect());
  }

  // Stream-only: only download the largest file, rest is wasted bandwidth
  if (streamOnly) {
    const primary = torrent.files.reduce((a, b) => b.length > a.length ? b : a);
    torrent.files.forEach(f => f.deselect());
    primary.select();
  }

  torrentMap.set(torrent.infoHash, torrent);

  if (!argv.json) {
    console.log(`\nAdded  : ${torrent.name}`);
    console.log(`Size   : ${bytes(torrent.length)}`);
    console.log(`Peers  : connecting...  |  Trackers: ${torrent.announce.length}`);
  }

  // Prebuffer gate — hold the stream URL until enough is downloaded
  if (streamMode) {
    const primary      = torrent.files.reduce((a, b) => b.length > a.length ? b : a);
    const primaryIndex = torrent.files.indexOf(primary);
    let   announced    = prebufferBytes === 0;

    if (announced) {
      printStreamLinks(torrent);
      autoOpenPlayer(torrent, primaryIndex);
    } else {
      if (!argv.json) console.log(`\n  Buffering ${argv.prebuffer}MB before stream URL appears...`);

      const checkBuffer = throttle(() => {
        if (!announced && torrent.downloaded >= prebufferBytes) {
          announced = true;
          torrent.removeListener("download", checkBuffer);
          printStreamLinks(torrent);
          autoOpenPlayer(torrent, primaryIndex);
        }
      }, 500);

      torrent.on("download", checkBuffer);
    }
  }

  // Progress display
  if (!streamOnly && !argv.json) {
    const bar = multiBar.create(1000, 0, {
      name:  name.padEnd(40),
      speed: "0 B/s",
      peers: "0 peers"
    });

    let lastTicked = 0;

    const updateBar = throttle(() => {
      const permille = Math.floor(torrent.progress * 1000);
      const delta    = permille - lastTicked;
      const speed    = bytes(torrent.downloadSpeed) + "/s";
      const peers    = torrent.numPeers + " peers";
      if (delta > 0) {
        bar.increment(delta, { speed, peers });
        lastTicked = permille;
      } else {
        bar.update(lastTicked, { speed, peers });
      }
    }, 250);

    torrent.on("download", updateBar);

    torrent.on("done", () => {
      const remaining = 1000 - lastTicked;
      if (remaining > 0) bar.increment(remaining, { speed: "0 B/s", peers: "0 peers" });
      multiBar.stop();
      printSummary(torrent);
      handlePostDownload(torrent);
    });

  } else if (argv.json) {
    const jsonUpdate = throttle(() => {
      process.stdout.write(JSON.stringify({
        name:       torrent.name,
        progress:   torrent.progress,
        speed:      torrent.downloadSpeed,
        peers:      torrent.numPeers,
        downloaded: torrent.downloaded,
        total:      torrent.length
      }) + "\n");
    }, 1000);

    torrent.on("download", jsonUpdate);
    torrent.on("done", () => {
      process.stdout.write(JSON.stringify({ name: torrent.name, status: "done" }) + "\n");
      handlePostDownload(torrent);
    });

  } else {
    // stream-only: simple speed line
    const speedUpdate = throttle(() => {
      process.stdout.write(
        `\r  ${bytes(torrent.downloadSpeed).padEnd(12)}/s  ` +
        `${String(torrent.numPeers).padEnd(4)} peers  ` +
        `${bytes(torrent.downloaded)} / ${bytes(torrent.length)}`
      );
    }, 1000);
    torrent.on("download", speedUpdate);
  }

  torrent.on("error", err => {
    console.error(`\nError [${name}]: ${err.message}`);
    finish();
  });
}

// ---------------------------------------------------------------------------
// Post-download
// ---------------------------------------------------------------------------
function handlePostDownload(torrent) {
  if (argv.seed || argv["seed-ratio"] > 0) {
    if (!argv.json) console.log(`\nSeeding ${torrent.name}...  (Ctrl+C to stop)`);

    if (argv["seed-ratio"] > 0) {
      const checkRatio = setInterval(() => {
        const ratio = torrent.uploaded / torrent.downloaded;
        if (ratio >= argv["seed-ratio"]) {
          clearInterval(checkRatio);
          if (!argv.json) console.log(`\nSeed ratio ${argv["seed-ratio"]} reached — stopping.`);
          torrent.destroy(() => finish());
        }
      }, 5000);
    }
  } else {
    torrent.destroy(() => finish());
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printStreamLinks(torrent) {
  const primary = torrent.files.reduce((a, b) => b.length > a.length ? b : a);

  if (argv.json) {
    torrent.files.forEach((f, i) => {
      process.stdout.write(JSON.stringify({
        event: "stream-ready",
        name:  f.name,
        url:   `http://localhost:${argv.port}/${torrent.infoHash}/${i}`
      }) + "\n");
    });
    return;
  }

  console.log("\n--------------------------------------------------");
  console.log("  STREAM LINKS — VLC: Media > Open Network Stream");
  console.log("--------------------------------------------------");
  torrent.files.forEach((f, i) => {
    const tag = f === primary ? " [PRIMARY]" : "";
    console.log(`  ${f.name}${tag}`);
    console.log(`  --> http://localhost:${argv.port}/${torrent.infoHash}/${i}`);
  });
  console.log("--------------------------------------------------\n");
}

function printSummary(torrent) {
  if (argv.json) return;
  console.log("\n--------------------------------------------------");
  torrent.files.forEach(f => console.log(`  ${f.path}  (${bytes(f.length)})`));
  console.log("--------------------------------------------------");
  console.log(`  Downloaded ${torrent.files.length} file(s)  -  ${bytes(torrent.length)}\n`);
}

function autoOpenPlayer(torrent, primaryIndex) {
  if (!argv.player) return;
  const url = `http://localhost:${argv.port}/${torrent.infoHash}/${primaryIndex}`;
  exec(`${argv.player} "${url}"`, err => {
    if (err && !argv.json) console.error(`Could not open player: ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Keyboard: P = pause/resume
// ---------------------------------------------------------------------------
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", (_, key) => {
    if (!key) return;
    if (key.name === "p") {
      client.torrents.forEach(t => {
        if (t.paused) { t.resume(); console.log("\nResumed"); }
        else          { t.pause();  console.log("\nPaused — press P to resume"); }
      });
    }
    if (key.ctrl && key.name === "c") {
      cleanup();
      client.destroy(() => process.exit(130));
    }
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
function finish() {
  active--;
  if (active <= 0) {
    cleanup();
    client.destroy(() => process.exit(0));
  }
}

function cleanup() {
  multiBar.stop();
  if (streamOnly && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

process.on("SIGINT", () => {
  if (!argv.json) console.log("\nInterrupted - closing...");
  cleanup();
  client.destroy(() => process.exit(130));
});
                                                 
