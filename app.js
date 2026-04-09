#!/usr/bin/env node

import WebTorrent from "webtorrent";
import { MultiBar, Presets } from "cli-progress";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import http from "http";
import https from "https";
import path from "path";
import os from "os";
import fs from "fs";
import { exec, execSync, spawn } from "child_process";
import readline from "readline";

// ---------------------------------------------------------------------------
// Suppress non-fatal uTP warning
// ---------------------------------------------------------------------------
const _consoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("uTP not supported")) return;
  _consoleError(...args);
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = yargs(hideBin(process.argv))
  .usage("Usage: $0 <magnet|torrent|url> [...] [options]")
  .option("path",           { alias: "o", type: "string",  default: ".",    describe: "Output directory" })
  .option("connections",    { alias: "c", type: "number",  default: 150,    describe: "Max peer connections (torrents)" })
  .option("threads",        { alias: "n", type: "number",  default: 4,      describe: "Parallel segments for HTTP downloads" })
  .option("trackers",       { alias: "t", type: "array",                    describe: "Extra tracker URLs" })
  .option("stream",         { alias: "s", type: "boolean", default: false,  describe: "Stream while downloading (torrents)" })
  .option("stream-only",    { alias: "S", type: "boolean", default: false,  describe: "Stream only, do not save to disk" })
  .option("port",           { alias: "p", type: "number",  default: 8888,   describe: "Stream server port" })
  .option("prebuffer",      { alias: "b", type: "number",  default: 5,      describe: "MB to buffer before stream URL appears" })
  .option("select",         {             type: "string",                    describe: "Torrent file indices to download e.g. --select 0,2" })
  .option("list",           {             type: "boolean", default: false,   describe: "List files in torrent and exit" })
  .option("seed",           {             type: "boolean", default: false,   describe: "Keep seeding after download completes" })
  .option("seed-ratio",     {             type: "number",  default: 0,       describe: "Stop seeding at this upload ratio e.g. 1.5" })
  .option("download-limit", {             type: "number",  default: 0,       describe: "Download speed limit MB/s (0 = unlimited)" })
  .option("upload-limit",   {             type: "number",  default: 0,       describe: "Upload speed limit MB/s (0 = unlimited)" })
  .option("player",         {             type: "string",                    describe: "Auto-open stream in player e.g. --player vlc" })
  .option("resume",         { alias: "r", type: "boolean", default: true,    describe: "Resume incomplete HTTP downloads" })
  .option("filename",       { alias: "f", type: "string",                   describe: "Override output filename for HTTP downloads" })
  .option("json",           {             type: "boolean", default: false,   describe: "Output status as JSON for scripting" })
  .option("trackers-auto",  {             type: "boolean", default: false,   describe: "Fetch latest public tracker list on startup" })
  .help()
  .argv;

const inputs     = argv._;
const streamOnly = argv["stream-only"];
const streamMode = streamOnly || argv.stream;

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
  ".ts":   "video/mp2t",
  ".m4v":  "video/mp4",
};

// ---------------------------------------------------------------------------
// Input type detection
// ---------------------------------------------------------------------------
const MEDIA_HOSTS = /youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitter\.com|x\.com|instagram\.com|reddit\.com|twitch\.tv|tiktok\.com|soundcloud\.com/i;

function detectInputType(input) {
  if (input.startsWith("magnet:")) return "torrent";
  if (/^https?:\/\//i.test(input)) {
    if (input.toLowerCase().endsWith(".torrent")) return "torrent";
    if (MEDIA_HOSTS.test(input)) return "ytdlp";
    return "http";
  }
  if (fs.existsSync(input) && input.toLowerCase().endsWith(".torrent")) return "torrent";
  return "torrent"; // best guess fallback
}

function binaryExists(bin) {
  try { execSync(`which ${bin} 2>/dev/null`); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Trackers
// ---------------------------------------------------------------------------
const defaultTrackers = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
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
// HTTP Downloader — multi-segment, resume-capable
// ---------------------------------------------------------------------------

// Follow redirects and collect metadata via HEAD request
function fetchFileInfo(url) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const reqOpts = { method: "HEAD", headers: { "User-Agent": "tget/3.0" } };

    const req = mod.request(url, reqOpts, res => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        fetchFileInfo(next).then(resolve).catch(reject);
        return;
      }

      // Extract filename
      const cd    = res.headers["content-disposition"] || "";
      const match = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
      let fileName = match
        ? decodeURIComponent(match[1].trim())
        : decodeURIComponent(path.basename(parsed.pathname) || "download");

      // Strip query string from filename if it leaked in
      fileName = fileName.split("?")[0] || "download";

      resolve({
        finalUrl:      url,
        fileName,
        size:          parseInt(res.headers["content-length"] || "0", 10),
        acceptsRanges: res.headers["accept-ranges"] === "bytes",
        contentType:   res.headers["content-type"] || "",
      });
    });

    req.setTimeout(15000, () => { req.destroy(); reject(new Error("HEAD request timed out")); });
    req.on("error", reject);
    req.end();
  });
}

// Single-stream download, optionally resuming from existing byte offset
function singleSegmentDownload(url, outPath, totalSize, resumeFrom, barRef) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const headers = {
      "User-Agent": "tget/3.0",
      ...(resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {}),
    };

    const req = mod.get(url, { headers }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        singleSegmentDownload(next, outPath, totalSize, resumeFrom, barRef).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      const writer           = fs.createWriteStream(outPath, { flags: resumeFrom > 0 ? "a" : "w" });
      let   downloaded       = resumeFrom;
      let   lastDownloaded   = resumeFrom;
      let   lastTime         = Date.now();

      res.on("data", chunk => {
        downloaded += chunk.length;
        if (barRef && totalSize > 0) {
          const now     = Date.now();
          const elapsed = (now - lastTime) / 1000;
          if (elapsed >= 0.25) {
            const speed    = (downloaded - lastDownloaded) / elapsed;
            const permille = Math.floor((downloaded / totalSize) * 1000);
            barRef.update(Math.min(permille, 1000), { speed: bytes(speed) + "/s", peers: "" });
            lastDownloaded = downloaded;
            lastTime       = now;
          }
        }
      });

      res.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error",  reject);
      res.on("error",     reject);
    });

    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Download timed out")); });
    req.on("error", reject);
  });
}

// Parallel multi-segment download; segments merged into final file
async function multiSegmentDownload(url, outPath, totalSize, numSegs) {
  const segSize  = Math.floor(totalSize / numSegs);
  const tmpFiles = [];
  const metaPath = outPath + ".tget-meta";

  // Load resume checkpoint
  let completedSegs = new Set();
  if (argv.resume && fs.existsSync(metaPath)) {
    try {
      const meta    = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      completedSegs = new Set(meta.completed || []);
      if (!argv.json) console.log(`  Resuming (${completedSegs.size}/${numSegs} segments complete)`);
    } catch { /* corrupted meta — restart cleanly */ }
  }

  const saveMeta = () => {
    try { fs.writeFileSync(metaPath, JSON.stringify({ completed: [...completedSegs] })); } catch {}
  };

  // Create one progress bar per segment
  const bars = [];
  for (let i = 0; i < numSegs; i++) {
    const segPath = `${outPath}.part${i}`;
    tmpFiles.push(segPath);
    if (!argv.json) {
      bars.push(multiBar.create(1000, completedSegs.has(i) ? 1000 : 0, {
        name:  `  seg-${i}`.padEnd(40),
        speed: completedSegs.has(i) ? "done" : "0 B/s",
        peers: "",
      }));
    } else {
      bars.push(null);
    }
  }

  const downloadSeg = (i) => new Promise((resolve, reject) => {
    if (completedSegs.has(i)) { resolve(); return; }

    const segPath    = tmpFiles[i];
    const rangeStart = i * segSize;
    const rangeEnd   = i === numSegs - 1 ? totalSize - 1 : (i + 1) * segSize - 1;
    const segTotal   = rangeEnd - rangeStart + 1;
    const existing   = fs.existsSync(segPath) ? fs.statSync(segPath).size : 0;
    const resumeFrom = (argv.resume && existing > 0 && existing < segTotal) ? existing : 0;

    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const start   = rangeStart + resumeFrom;
    const headers = { "User-Agent": "tget/3.0", Range: `bytes=${start}-${rangeEnd}` };

    const req = mod.get(url, { headers }, res => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        reject(new Error(`Segment ${i}: HTTP ${res.statusCode}`));
        return;
      }

      const writer         = fs.createWriteStream(segPath, { flags: resumeFrom > 0 ? "a" : "w" });
      let   downloaded     = resumeFrom;
      let   lastDownloaded = resumeFrom;
      let   lastTime       = Date.now();

      res.on("data", chunk => {
        downloaded += chunk.length;
        const now     = Date.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed >= 0.25 && bars[i]) {
          const speed = (downloaded - lastDownloaded) / elapsed;
          bars[i].update(Math.min(Math.floor((downloaded / segTotal) * 1000), 1000), {
            speed: bytes(speed) + "/s", peers: "",
          });
          lastDownloaded = downloaded;
          lastTime       = now;
        }
      });

      res.pipe(writer);
      writer.on("finish", () => {
        completedSegs.add(i);
        saveMeta();
        if (bars[i]) bars[i].update(1000, { speed: "done", peers: "" });
        resolve();
      });
      writer.on("error", reject);
      res.on("error",    reject);
    });

    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Segment ${i} timed out`)); });
    req.on("error", reject);
  });

  await Promise.all(Array.from({ length: numSegs }, (_, i) => downloadSeg(i)));

  stopBars();

  // Merge segments sequentially into final file
  if (!argv.json) process.stdout.write(`\n  Merging ${numSegs} segments...`);

  const outFd = fs.openSync(outPath, "w");
  for (const segFile of tmpFiles) {
    const data = fs.readFileSync(segFile);
    fs.writeSync(outFd, data);
    fs.unlinkSync(segFile);
  }
  fs.closeSync(outFd);

  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  if (!argv.json) console.log(" done");
}

async function httpDownload(url, outputDir) {
  let info;
  try {
    info = await fetchFileInfo(url);
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err.message}`);
  }

  const fileName = argv.filename || info.fileName || "download";
  const outPath  = path.resolve(outputDir, fileName);

  if (!argv.json) {
    console.log(`\nHTTP Download`);
    console.log(`  URL     : ${url}`);
    console.log(`  File    : ${outPath}`);
    if (info.size)          console.log(`  Size    : ${bytes(info.size)}`);
    if (info.contentType)   console.log(`  Type    : ${info.contentType.split(";")[0]}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const canMulti  = info.acceptsRanges && info.size > 0 && argv.threads > 1;
  const numSegs   = canMulti ? argv.threads : 1;

  if (!argv.json) console.log(`  Segments: ${numSegs}\n`);

  if (numSegs === 1) {
    // Single stream — resume from existing bytes if possible
    const existing  = (argv.resume && fs.existsSync(outPath)) ? fs.statSync(outPath).size : 0;
    const resumeFrom = (existing > 0 && info.size > 0 && existing < info.size) ? existing : 0;
    if (resumeFrom > 0 && !argv.json) console.log(`  Resuming from ${bytes(resumeFrom)}\n`);

    let bar = null;
    if (!argv.json && info.size > 0) {
      bar = multiBar.create(1000, Math.floor((resumeFrom / info.size) * 1000), {
        name:  fileName.slice(0, 40).padEnd(40),
        speed: "0 B/s",
        peers: "",
      });
    }

    await singleSegmentDownload(info.finalUrl, outPath, info.size, resumeFrom, bar);
    stopBars();
  } else {
    await multiSegmentDownload(info.finalUrl, outPath, info.size, numSegs);
  }

  if (!argv.json) {
    const finalSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : info.size;
    console.log(`\n  Saved : ${outPath}  (${bytes(finalSize)})\n`);
  } else {
    process.stdout.write(JSON.stringify({ status: "done", file: outPath }) + "\n");
  }
}

// ---------------------------------------------------------------------------
// yt-dlp wrapper
// ---------------------------------------------------------------------------
function ytdlpDownload(url, outputDir) {
  if (!binaryExists("yt-dlp")) {
    console.error(
      "yt-dlp not found.\n" +
      "  Ubuntu/Debian : pip3 install yt-dlp\n" +
      "  Termux        : pkg install yt-dlp\n" +
      "  Arch          : pacman -S yt-dlp"
    );
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  if (!argv.json) {
    console.log(`\nyt-dlp  : ${url}`);
    console.log(`  Output: ${path.resolve(outputDir)}\n`);
  }

  const template = argv.filename
    ? path.join(outputDir, argv.filename)
    : path.join(outputDir, "%(title)s.%(ext)s");

  const args = [url, "-o", template, "--no-playlist", "--progress"];
  const proc = spawn("yt-dlp", args, { stdio: argv.json ? "ignore" : "inherit" });

  proc.on("error", err => {
    console.error(`yt-dlp error: ${err.message}`);
    checkAllDone();
  });
  proc.on("close", code => {
    if (code !== 0 && !argv.json) console.error(`yt-dlp exited with code ${code}`);
    checkAllDone();
  });
}

// ---------------------------------------------------------------------------
// Global stream server — routes by /<infoHash>/<fileIndex>
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

    if (!file) { res.writeHead(404); res.end("Not found"); return; }

    file.select();

    const ext      = path.extname(file.name).toLowerCase();
    const mimeType = mimeTypes[ext] || "application/octet-stream";
    const fileSize = file.length;
    const range    = req.headers.range;

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type":   mimeType,
        "Accept-Ranges":  "bytes",
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
        "Content-Type":   mimeType,
      });
      stream = file.createReadStream({ start, end });
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type":   mimeType,
        "Accept-Ranges":  "bytes",
      });
      stream = file.createReadStream();
    }

    stream.on("error", () => {});
    res.on("close",    () => stream.destroy());
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
// Progress bars — shared, with double-stop guard
// ---------------------------------------------------------------------------
const multiBar = new MultiBar({
  format:            "  {name} [{bar}] {percentage}%  {speed}  {peers}  eta {eta}s",
  barCompleteChar:   "=",
  barIncompleteChar: " ",
  clearOnComplete:   false,
  hideCursor:        true,
  autopadding:       true,
}, Presets.shades_classic);

let barsStopped = false;
function stopBars() {
  if (!barsStopped) { barsStopped = true; multiBar.stop(); }
}

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------
const tmpDir      = path.join(os.tmpdir(), `tget-${process.pid}`);
const storagePath = path.resolve(streamOnly ? tmpDir : argv.path);

if (streamOnly) fs.mkdirSync(tmpDir,      { recursive: true });
else            fs.mkdirSync(storagePath, { recursive: true });

// ---------------------------------------------------------------------------
// WebTorrent client
// ---------------------------------------------------------------------------
const client = new WebTorrent({ maxConns: argv.connections });

client.on("error", err => {
  console.error("Client error:", err.message);
  cleanup();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Task counter
// ---------------------------------------------------------------------------
let active = inputs.length;

function checkAllDone() {
  active--;
  if (active <= 0) {
    cleanup();
    client.destroy(() => process.exit(0));
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  const trackers = await resolveTrackers();
  if (streamMode) ensureStreamServer();

  for (const input of inputs) {
    const type = detectInputType(input);

    if (type === "ytdlp") {
      ytdlpDownload(input, storagePath);

    } else if (type === "http") {
      httpDownload(input, storagePath)
        .then(() => checkAllDone())
        .catch(err => {
          console.error(`HTTP error [${input}]: ${err.message}`);
          checkAllDone();
        });

    } else {
      // magnet, .torrent file, or .torrent URL — WebTorrent handles all three
      client.add(input, {
        path:        storagePath,
        announce:    trackers,
        maxWebConns: argv.connections,
      }, torrent => onTorrent(torrent));
    }
  }
})();

// ---------------------------------------------------------------------------
// Per-torrent handler
// ---------------------------------------------------------------------------
function onTorrent(torrent) {
  const name = (torrent.name || torrent.infoHash).slice(0, 40);

  // FIX: torrent.downloadLimit/uploadLimit are read-only; use client-level throttle
  if (argv["download-limit"] > 0) client.throttleDownload(argv["download-limit"] * 1024 * 1024);
  if (argv["upload-limit"]   > 0) client.throttleUpload(argv["upload-limit"]     * 1024 * 1024);

  // --list: print files and exit
  if (argv.list) {
    console.log(`\n${torrent.name}`);
    torrent.files.forEach((f, i) => console.log(`  [${i}] ${f.name}  (${bytes(f.length)})`));
    torrent.destroy(() => checkAllDone());
    return;
  }

  // Selective file download
  if (argv.select) {
    const selected = new Set(argv.select.split(",").map(Number));
    torrent.files.forEach((f, i) => selected.has(i) ? f.select() : f.deselect());
  }

  // Stream-only: keep only the largest file in RAM
  if (streamOnly) {
    const primary = torrent.files.reduce((a, b) => b.length > a.length ? b : a);
    torrent.files.forEach(f => f.deselect());
    primary.select();
  }

  torrentMap.set(torrent.infoHash, torrent);

  if (!argv.json) {
    console.log(`\nAdded    : ${torrent.name}`);
    console.log(`Size     : ${bytes(torrent.length)}`);
    console.log(`Peers    : connecting...  |  Trackers: ${torrent.announce.length}`);
  }

  // Prebuffer gate for streaming
  if (streamMode) {
    const primary        = torrent.files.reduce((a, b) => b.length > a.length ? b : a);
    const primaryIndex   = torrent.files.indexOf(primary);
    const prebufferBytes = argv.prebuffer * 1024 * 1024;
    let   announced      = prebufferBytes === 0;

    if (announced) {
      printStreamLinks(torrent);
      autoOpenPlayer(torrent, primaryIndex);
    } else {
      if (!argv.json) console.log(`\n  Buffering ${argv.prebuffer} MB before stream URL appears...`);

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
      peers: "0 peers",
    });

    let lastTicked = 0;

    const updateBar = throttle(() => {
      const permille = Math.floor(torrent.progress * 1000);
      const delta    = permille - lastTicked;
      const speed    = bytes(torrent.downloadSpeed) + "/s";
      const peers    = torrent.numPeers + " peers";
      if (delta > 0) { bar.increment(delta, { speed, peers }); lastTicked = permille; }
      else           { bar.update(lastTicked, { speed, peers }); }
    }, 250);

    torrent.on("download", updateBar);

    torrent.on("done", () => {
      const rem = 1000 - lastTicked;
      if (rem > 0) bar.increment(rem, { speed: "0 B/s", peers: "0 peers" });
      stopBars();
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
        total:      torrent.length,
      }) + "\n");
    }, 1000);

    torrent.on("download", jsonUpdate);
    torrent.on("done", () => {
      process.stdout.write(JSON.stringify({ name: torrent.name, status: "done" }) + "\n");
      handlePostDownload(torrent);
    });

  } else {
    // stream-only mode — compact speed line, no bar
    const speedUpdate = throttle(() => {
      process.stdout.write(
        `\r  ${bytes(torrent.downloadSpeed).padEnd(12)}/s  ` +
        `${String(torrent.numPeers).padEnd(4)} peers  ` +
        `${bytes(torrent.downloaded)} / ${bytes(torrent.length)}`
      );
    }, 1000);
    torrent.on("download", speedUpdate);
    torrent.on("done", () => { process.stdout.write("\n"); handlePostDownload(torrent); });
  }

  torrent.on("error", err => {
    console.error(`\nError [${name}]: ${err.message}`);
    checkAllDone();
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
        if (torrent.downloaded === 0) return;
        const ratio = torrent.uploaded / torrent.downloaded;
        if (ratio >= argv["seed-ratio"]) {
          clearInterval(checkRatio);
          if (!argv.json) console.log(`\nSeed ratio ${argv["seed-ratio"]} reached — stopping.`);
          torrent.destroy(() => checkAllDone());
        }
      }, 5000);
    }
  } else {
    torrent.destroy(() => checkAllDone());
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
        url:   `http://localhost:${argv.port}/${torrent.infoHash}/${i}`,
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
// Keyboard — P: pause/resume, L: peer log, Ctrl+C: exit
// FIX: wrapped in try/catch so Termux non-TTY doesn't crash
// ---------------------------------------------------------------------------
let peerLogActive = false;

if (process.stdin.isTTY) {
  try {
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

      // FIX: L key was in README but missing from code
      if (key.name === "l") {
        peerLogActive = !peerLogActive;
        console.log(peerLogActive ? "\n  [Peer log ON  — press L to hide]" : "\n  [Peer log OFF]");
        if (peerLogActive) {
          client.torrents.forEach(t => {
            t.on("wire", wire => {
              if (peerLogActive)
                console.log(`\n  + peer connected: ${wire.remoteAddress}`);
            });
          });
        }
      }

      if (key.ctrl && key.name === "c") {
        cleanup();
        client.destroy(() => process.exit(130));
      }
    });
  } catch (_) {
    // Non-TTY or Termux environment — keyboard controls unavailable, continue silently
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
function cleanup() {
  stopBars();
  if (streamServer) { try { streamServer.close(); } catch {} streamServer = null; }
  if (streamOnly && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

process.on("SIGINT", () => {
  if (!argv.json) console.log("\nInterrupted — closing...");
  cleanup();
  client.destroy(() => process.exit(130));
});

// FIX: SIGTERM was unhandled — orphaned process on system kill
process.on("SIGTERM", () => {
  cleanup();
  client.destroy(() => process.exit(0));
});

// FIX: uncaughtException was unhandled — left tmp files and open ports on crash
process.on("uncaughtException", err => {
  console.error(`Fatal: ${err.message}`);
  cleanup();
  process.exit(1);
});
