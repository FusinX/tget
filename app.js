#!/usr/bin/env node

"use strict";

const WebTorrent = require("webtorrent");
const numeral    = require("numeral");
const ProgressBar = require("progress");
const optimist   = require("optimist");
const rc         = require("rc");

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------
const argv = rc("tget", {
  connections: 150,
  path:        ".",
  trackers:    []
}, optimist
  .usage("Usage: $0 <magnet-link-or-torrent> [...] [options]")
  .options({
    path:        { alias: "o", describe: "Output directory",              default: "."   },
    connections: { alias: "c", describe: "Max peer connections per torrent", default: 150 },
    trackers:    { alias: "t", describe: "Extra tracker URLs (repeatable)"               }
  })
  .argv
);

const inputs = argv._;

if (inputs.length === 0) {
  optimist.showHelp();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const bytes = n => numeral(n).format("0.0b");

const extraTrackers = Array.isArray(argv.trackers)
  ? argv.trackers
  : argv.trackers
    ? [argv.trackers]
    : [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.tracker.cl:1337/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://tracker.openbittorrent.com:6969/announce"
      ];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
const client = new WebTorrent({ maxConns: argv.connections });

client.on("error", err => {
  console.error("Client error:", err.message);
  process.exit(1);
});

// Track how many torrents are still active so we know when to exit.
let active = inputs.length;

inputs.forEach(input => {
  const opts = {
    path:            argv.path,
    announce:        extraTrackers,
    maxWebConns:     argv.connections
  };

  client.add(input, opts, torrent => onTorrent(torrent));
});

// ---------------------------------------------------------------------------
// Per-torrent handler
// ---------------------------------------------------------------------------
function onTorrent(torrent) {
  const name      = torrent.name || torrent.infoHash;
  const totalSize = bytes(torrent.length);

  console.log(`\nAdded: ${name}  (${totalSize})`);
  console.log(`Peers: connecting…  |  Trackers: ${torrent.announce.length}`);

  const bar = new ProgressBar(
    "  [:bar] :percent  :speed  :peers  eta :etas",
    {
      complete:   "=",
      incomplete: " ",
      width:      32,
      total:      1000       // we tick in per-mille units for smooth updates
    }
  );

  let lastTicked = 0;

  const timerId = setInterval(() => {
    const pct        = torrent.progress;           // 0–1
    const permille   = Math.floor(pct * 1000);
    const delta      = permille - lastTicked;
    const speed      = bytes(torrent.downloadSpeed) + "/s";
    const peers      = torrent.numPeers + " peers";

    if (delta > 0) {
      bar.tick(delta, { speed, peers });
      lastTicked = permille;
    } else {
      // Redraw current line without advancing bar
      bar.tick(0, { speed, peers });
    }
  }, 500);

  torrent.on("error", err => {
    clearInterval(timerId);
    console.error(`\nError [${name}]: ${err.message}`);
    finish();
  });

  torrent.on("done", () => {
    clearInterval(timerId);

    // Force bar to 100 %
    const remaining = 1000 - lastTicked;
    if (remaining > 0) bar.tick(remaining, { speed: "0b/s", peers: "0 peers" });

    console.log("\n--------------------------------------------------");
    torrent.files.forEach(f => console.log(`  ${f.path}  (${bytes(f.length)})`));
    console.log("--------------------------------------------------");
    console.log(
      `  Downloaded ${torrent.files.length} file(s)  —  ${bytes(torrent.length)}\n`
    );

    torrent.destroy(() => finish());
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function finish() {
  active--;
  if (active <= 0) {
    client.destroy(() => process.exit(0));
  }
}

process.on("SIGINT", () => {
  console.log("\nInterrupted — closing…");
  client.destroy(() => process.exit(130));
});
