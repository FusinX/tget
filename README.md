<p align="center">
<a href="https://github.com/FusinX/tget">
<img alt="tget is wget for torrents" src="https://raw.githubusercontent.com/FusinX/tget/master/banner.png" width="600">
</a>
</p>
# tget
**tget** is a modern, fast, and lightweight CLI torrent client for Linux, macOS, and Android (Termux). It features built-in HTTP streaming support, allowing you to watch movies or listen to music while they download.
## ⚡ Quick Start
### 1. Install System Dependencies
tget requires a C++ compiler to build high-performance networking modules (node-datachannel). Run the command for your system:
| Platform | Command |
|---|---|
| **Ubuntu / Debian** | sudo apt install build-essential python3 nodejs npm |
| **Fedora** | sudo dnf groupinstall "Development Tools" python3 |
| **Arch Linux** | sudo pacman -S base-devel python |
| **Termux (Android)** | pkg install clang make python nodejs |
### 2. Install tget
To install this specific modified version directly from the source:
```bash
# Clone the repository
git clone https://github.com/FusinX/tget.git
cd tget

# Install dependencies and link globally
npm install
npm install -g .

```
## 🚀 Usage
tget works with magnet links or local .torrent files.
```bash
# Basic download
tget 'magnet:?xt=urn:btih:...'

# Download from a file
tget ./movie.torrent

```
### 📂 File Management
**List files inside a torrent:**
```bash
tget 'magnet:...' --list

```
**Download specific files (using indices from --list):**
```bash
tget 'magnet:...' --select 0,2 -o ~/Downloads

```
### 📺 Streaming Support
**Stream while downloading (saves to disk):**
```bash
tget 'magnet:...' -o ~/Downloads --stream

```
**Stream only (RAM only, no disk write):**
```bash
tget 'magnet:...' --stream-only --player vlc

```
## 🛠 Options & Flags
| Flag | Alias | Default | Description |
|---|---|---|---|
| --path | -o | . | Output directory |
| --connections | -c | 150 | Max peer connections |
| --trackers-auto | — | false | Fetch latest public tracker list on startup |
| --stream | -s | false | Stream while downloading |
| --stream-only | -S | false | Memory-only streaming |
| --port | -p | 8888 | Stream server port |
| --prebuffer | -b | 5 | MB to buffer before stream starts |
| --list | — | false | Show file list and exit |
| --select | — | — | Indices to download (e.g. 0,2,3) |
| --seed | — | false | Continue seeding after download |
| --player | — | — | Auto-open in player (e.g. vlc, mpv) |
| --json | — | false | Raw JSON output for scripts |
## ⌨️ Keyboard Controls
While the client is active:
 * **P**: Toggle Pause / Resume
 * **L**: Toggle detailed peer logs
 * **Ctrl + C**: Graceful exit (saves progress)
## 🤖 JSON Mode
Perfect for piping into jq or building custom dashboards.
```bash
tget 'magnet:...' --json | jq .

```
## 📝 Technical Notes
 * **Sequential Selection:** When a player connects to the stream, tget automatically prioritizes the pieces needed for playback.
 * **Range Requests:** Supports seeking. You can jump to the middle of a movie in VLC, and tget will re-prioritize pieces accordingly.
 * **Efficiency:** In --stream-only mode, only the selected file is kept in memory; others are ignored to save bandwidth.
## ❤️ Credits
Modified and maintained by **FusinX**.
Built on WebTorrent. Inspired by peerflix.
## 📄 License
MIT © FusinX
