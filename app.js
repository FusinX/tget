#!/usr/bin/env node

import WebTorrent  from "webtorrent";
import numeral     from "numeral";
import ProgressBar from "progress";
import optimist    from "optimist";
import rc          from "rc";

const argv = rc("tget", {
  connections: 150,
  path:        ".",
  trackers:    [],
  stream:      false,
  port:        8888
}, optimist
  .usage("Usage: $0 <magnet-link-or-torrent> [...] [options]")
  .options({
    path:        { alias: "o", describe: "Output directory",                 default: "."    },
    connections: { alias: "c", describe: "Max peer connections per torrent", default: 150    },
    trackers:    { alias: "t", describe: "Extra tracker URLs (repeatable)"                   },
    stream:      { alias: "s", describe: "Generate stream URLs for VLC",     boolean: true   },
    port:        { alias: "p", describe: "Port for stream server",           default: 8888   }
  })
  .argv
);

const inputs = argv._;

if (inputs.length === 0) {
  optimist.showHelp();
  process.exit(1);
}

const bytes = n => numeral(n).format("0.0b");

const extraTrackers = Array.isArray(argv.trackers) && argv.trackers.length
  ? argv.trackers
  : [
      "udp://tracker.opentrackr.org:1337/announce",
      "udp://open.tracker.cl:1337/announce",
      "udp://tracker.torrent.eu.org:451/announce",
      "udp://tracker.openbittorrent.com:6969/announce"
    ];

const client = new WebTorrent({ maxConns: argv.connections });

client.on("error", err => {
  console.error("Client error:", err.message);
  process.exit(1);
});

let active = inputs.length;

inputs.forEach(input => {
  client.add(input, {
    path:        argv.path,
    announce:    extraTrackers,
    maxWebConns: argv.connections
  }, torrent => onTorrent(torrent));
});

function onTorrent(torrent) {
  const name = torrent.name || torrent.infoHash;

  console.log(`\nAdded: ${name}  (${bytes(torrent.length)})`);
  console.log(`Peers: connecting...  |  Trackers: ${torrent.announce.length}`);

  // -------------------------------------------------------------------------
  // Stream server
  // -------------------------------------------------------------------------
  if (argv.stream) {
    import("http").then(({ default: http }) => {
      const server = http.createServer((req, res) => {
        const index = parseInt(req.url.slice(1)) || 0;
        const file  = torrent.files[index];

        if (!file) {
          res.writeHead(404);
          res.end("File not found");
          return;
        }

        const fileSize = file.length;
        const range    = req.headers.range;

        if (range) {
          const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
          const start = parseInt(startStr, 10);
          const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;

          res.writeHead(206, {
            "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges":  "bytes",
            "Content-Length": end - start + 1,
            "Content-Type":   "video/x-matroska"
          });

          file.createReadStream({ start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Length": fileSize,
            "Content-Type":   "video/x-matroska",
            "Accept-Ranges":  "bytes"
          });

          file.createReadStream().pipe(res);
        }
      });

      server.listen(argv.port, () => {
        console.log("\n--------------------------------------------------");
        console.log("  STREAM LINKS (open in VLC > Network Stream)");
        console.log("--------------------------------------------------");
        torrent.files.forEach((f, i) => {
          console.log(`  ${f.name}`);
          console.log(`  --> http://localhost:${argv.port}/${i}`);
        });
        console.log("--------------------------------------------------\n");
      });
    });
  }
  // -------------------------------------------------------------------------
  // Progress bar
  // -------------------------------------------------------------------------
  const bar = new ProgressBar(
    "  [:bar] :percent  :speed  :peers  eta :etas",
    { complete: "=", incomplete: " ", width: 32, total: 1000 }
  );

  let lastTicked = 0;

  const timerId = setInterval(() => {
    const permille = Math.floor(torrent.progress * 1000);
    const delta    = permille - lastTicked;
    const speed    = bytes(torrent.downloadSpeed) + "/s";
    const peers    = torrent.numPeers + " peers";
    bar.tick(delta > 0 ? delta : 0, { speed, peers });
    if (delta > 0) lastTicked = permille;
  }, 500);

  torrent.on("error", err => {
    clearInterval(timerId);
    console.error(`\nError [${name}]: ${err.message}`);
    finish();
  });

  torrent.on("done", () => {
    clearInterval(timerId);
    const remaining = 1000 - lastTicked;
    if (remaining > 0) bar.tick(remaining, { speed: "0b/s", peers: "0 peers" });
    console.log("\n--------------------------------------------------");
    torrent.files.forEach(f => console.log(`  ${f.path}  (${bytes(f.length)})`));
    console.log("--------------------------------------------------");
    console.log(`  Downloaded ${torrent.files.length} file(s)  -  ${bytes(torrent.length)}\n`);
    torrent.destroy(() => finish());
  });
}

function finish() {
  active--;
  if (active <= 0) client.destroy(() => process.exit(0));
}

process.on("SIGINT", () => {
  console.log("\nInterrupted - closing...");
  client.destroy(() => process.exit(130));
});
