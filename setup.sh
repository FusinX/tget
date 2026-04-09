#!/usr/bin/env bash
# =============================================================================
# tget — setup.sh
# Cross-platform installer: Ubuntu/Debian, Fedora/RHEL/CentOS, Arch, openSUSE,
# Alpine, macOS (Homebrew), Termux (Android)
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Colours
# -----------------------------------------------------------------------------
R='\033[0;31m'  # red
G='\033[0;32m'  # green
Y='\033[0;33m'  # yellow
B='\033[0;34m'  # blue
C='\033[0;36m'  # cyan
W='\033[1;37m'  # white bold
N='\033[0m'     # reset

# -----------------------------------------------------------------------------
# Logging helpers
# -----------------------------------------------------------------------------
info()    { echo -e "${B}[INFO]${N}  $*"; }
ok()      { echo -e "${G}[ OK ]${N}  $*"; }
warn()    { echo -e "${Y}[WARN]${N}  $*"; }
err()     { echo -e "${R}[ERR ]${N}  $*" >&2; }
die()     { err "$*"; exit 1; }
section() { echo -e "\n${W}── $* ──${N}"; }

# -----------------------------------------------------------------------------
# Banner
# -----------------------------------------------------------------------------
banner() {
  echo -e "${C}"
  cat << 'EOF'
  ████████╗ ██████╗ ███████╗████████╗
     ██╔══╝██╔════╝ ██╔════╝╚══██╔══╝
     ██║   ██║  ███╗█████╗     ██║
     ██║   ██║   ██║██╔══╝     ██║
     ██║   ╚██████╔╝███████╗   ██║
     ╚═╝    ╚═════╝ ╚══════╝   ╚═╝
          setup.sh — universal installer
EOF
  echo -e "${N}"
}

# -----------------------------------------------------------------------------
# Platform detection
# -----------------------------------------------------------------------------
PLATFORM=""
PKG_MANAGER=""
IS_TERMUX=false
IS_MACOS=false
IS_ROOT=false
NODE_MIN=18

detect_platform() {
  section "Detecting platform"

  # Termux (Android)
  if [[ -n "${PREFIX:-}" && -d "$PREFIX/bin" && "$PREFIX" == *"com.termux"* ]]; then
    PLATFORM="termux"
    PKG_MANAGER="pkg"
    IS_TERMUX=true
    ok "Termux (Android)"
    return
  fi

  # macOS
  if [[ "$(uname -s)" == "Darwin" ]]; then
    PLATFORM="macos"
    PKG_MANAGER="brew"
    IS_MACOS=true
    ok "macOS"
    return
  fi

  # Linux — read /etc/os-release
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    local id="${ID:-}"
    local id_like="${ID_LIKE:-}"
    local combined="${id} ${id_like}"

    case "$combined" in
      *debian*|*ubuntu*)
        PLATFORM="debian"; PKG_MANAGER="apt" ;;
      *fedora*|*rhel*|*centos*|*rocky*|*alma*)
        if command -v dnf &>/dev/null; then
          PLATFORM="fedora"; PKG_MANAGER="dnf"
        else
          PLATFORM="centos"; PKG_MANAGER="yum"
        fi ;;
      *arch*|*manjaro*|*endeavour*)
        PLATFORM="arch"; PKG_MANAGER="pacman" ;;
      *suse*|*opensuse*)
        PLATFORM="suse"; PKG_MANAGER="zypper" ;;
      *alpine*)
        PLATFORM="alpine"; PKG_MANAGER="apk" ;;
      *)
        warn "Unrecognised distro: ${id}. Trying apt fallback."
        PLATFORM="debian"; PKG_MANAGER="apt" ;;
    esac
    ok "Linux / ${PLATFORM} (${NAME:-unknown})"
    return
  fi

  die "Cannot determine platform. Please install dependencies manually."
}

# Check if running as root (skip on Termux/macOS where it's irrelevant)
check_root() {
  if [[ "$IS_TERMUX" == false && "$IS_MACOS" == false ]]; then
    if [[ "$(id -u)" -eq 0 ]]; then
      IS_ROOT=true
      SUDO=""
    else
      if ! command -v sudo &>/dev/null; then
        die "Not root and sudo not found. Run as root or install sudo."
      fi
      SUDO="sudo"
    fi
  else
    SUDO=""
  fi
}

# -----------------------------------------------------------------------------
# Package manager wrappers
# -----------------------------------------------------------------------------
pkg_update() {
  info "Updating package index..."
  case "$PKG_MANAGER" in
    apt)    $SUDO apt-get update -qq ;;
    dnf)    $SUDO dnf check-update -q || true ;;
    yum)    $SUDO yum check-update -q || true ;;
    pacman) $SUDO pacman -Sy --noconfirm ;;
    zypper) $SUDO zypper refresh -q ;;
    apk)    $SUDO apk update -q ;;
    pkg)    pkg update -y ;;
    brew)   brew update --quiet ;;
  esac
}

pkg_install() {
  # Usage: pkg_install <friendly-name> <pkg1> [pkg2 ...]
  local friendly="$1"; shift
  info "Installing ${friendly}..."
  case "$PKG_MANAGER" in
    apt)    $SUDO apt-get install -y -qq "$@" ;;
    dnf)    $SUDO dnf install -y -q "$@" ;;
    yum)    $SUDO yum install -y -q "$@" ;;
    pacman) $SUDO pacman -S --noconfirm --needed "$@" ;;
    zypper) $SUDO zypper install -y -q "$@" ;;
    apk)    $SUDO apk add -q "$@" ;;
    pkg)    pkg install -y "$@" ;;
    brew)   brew install "$@" ;;
  esac
  ok "${friendly} installed"
}

has() { command -v "$1" &>/dev/null; }

# -----------------------------------------------------------------------------
# Node.js — verify version or install via NodeSource / nvm
# -----------------------------------------------------------------------------
install_node() {
  section "Node.js (>= ${NODE_MIN})"

  if has node; then
    local ver
    ver=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
    if [[ "$ver" -ge "$NODE_MIN" ]]; then
      ok "Node.js ${ver} already installed"
      return
    fi
    warn "Node.js ${ver} found but tget requires >= ${NODE_MIN}. Upgrading..."
  fi

  case "$PLATFORM" in
    termux)
      pkg_install "Node.js" nodejs ;;

    macos)
      pkg_install "Node.js" node ;;

    debian)
      info "Adding NodeSource repository for Node.js ${NODE_MIN}..."
      $SUDO apt-get install -y -qq curl ca-certificates gnupg
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      $SUDO apt-get install -y -qq nodejs
      ok "Node.js installed via NodeSource" ;;

    fedora)
      # Fedora 38+ has Node 20 in main repo; older ones need nvm
      if $SUDO dnf install -y -q "nodejs >= ${NODE_MIN}" 2>/dev/null; then
        ok "Node.js installed via dnf"
      else
        install_node_via_nvm
      fi ;;

    centos)
      info "Adding NodeSource for CentOS..."
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      $SUDO yum install -y nodejs
      ok "Node.js installed via NodeSource" ;;

    arch)
      pkg_install "Node.js" nodejs npm ;;

    suse)
      pkg_install "Node.js" nodejs npm ;;

    alpine)
      pkg_install "Node.js" nodejs npm ;;

    *)
      warn "Unknown platform for Node install — falling back to nvm"
      install_node_via_nvm ;;
  esac

  # Final version check
  local ver
  ver=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  [[ "$ver" -ge "$NODE_MIN" ]] || die "Node.js install failed or version still < ${NODE_MIN}"
  ok "Node.js $(node --version)"
}

install_node_via_nvm() {
  info "Installing Node.js via nvm..."
  export NVM_DIR="${HOME}/.nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck disable=SC1090
  source "${NVM_DIR}/nvm.sh"
  nvm install "${NODE_MIN}"
  nvm use "${NODE_MIN}"
  nvm alias default "${NODE_MIN}"
  ok "Node.js $(node --version) via nvm"

  # Persist nvm into shell rc files
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
    if [[ -f "$rc" ]] && ! grep -q "NVM_DIR" "$rc"; then
      cat >> "$rc" << 'NVMRC'

# nvm — added by tget setup
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
NVMRC
    fi
  done
}

# -----------------------------------------------------------------------------
# Build tools (required by node-datachannel)
# -----------------------------------------------------------------------------
install_build_tools() {
  section "Build tools (C++ compiler)"

  case "$PLATFORM" in
    termux)
      pkg_install "build tools" clang make python ;;
    macos)
      if ! has xcode-select || ! xcode-select -p &>/dev/null; then
        info "Installing Xcode Command Line Tools..."
        xcode-select --install 2>/dev/null || true
        warn "If a dialog appeared, complete it then re-run this script."
      else
        ok "Xcode CLT already present"
      fi ;;
    debian)
      pkg_install "build tools" build-essential python3 ;;
    fedora|centos)
      pkg_install "build tools" gcc-c++ make python3 ;;
    arch)
      pkg_install "build tools" base-devel python ;;
    suse)
      pkg_install "build tools" gcc-c++ make python3 ;;
    alpine)
      pkg_install "build tools" alpine-sdk python3 ;;
  esac

  has node-gyp || npm install -g node-gyp --silent
  ok "Build tools ready"
}

# -----------------------------------------------------------------------------
# yt-dlp
# -----------------------------------------------------------------------------
install_ytdlp() {
  section "yt-dlp"

  if has yt-dlp; then
    ok "yt-dlp already installed ($(yt-dlp --version))"
    info "Updating yt-dlp..."
    yt-dlp -U --quiet || true
    return
  fi

  case "$PLATFORM" in
    termux)
      pkg_install "yt-dlp" yt-dlp ;;
    macos)
      pkg_install "yt-dlp" yt-dlp ;;
    arch)
      pkg_install "yt-dlp" yt-dlp ;;
    alpine)
      if has pip3; then
        pip3 install --quiet yt-dlp
      else
        pkg_install "pip3" py3-pip
        pip3 install --quiet yt-dlp
      fi ;;
    *)
      if has pip3; then
        info "Installing yt-dlp via pip3..."
        pip3 install --quiet --user yt-dlp
        # Ensure ~/.local/bin is on PATH
        local local_bin="${HOME}/.local/bin"
        if [[ ":$PATH:" != *":${local_bin}:"* ]]; then
          export PATH="${local_bin}:$PATH"
          for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
            if [[ -f "$rc" ]] && ! grep -q "\.local/bin" "$rc"; then
              echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
            fi
          done
        fi
        ok "yt-dlp $(yt-dlp --version)"
      else
        warn "pip3 not found — installing via binary fallback..."
        local ytdlp_bin="/usr/local/bin/yt-dlp"
        $SUDO curl -fsSL \
          "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
          -o "$ytdlp_bin"
        $SUDO chmod +x "$ytdlp_bin"
        ok "yt-dlp $(yt-dlp --version) (binary)"
      fi ;;
  esac
}

# -----------------------------------------------------------------------------
# Optional but useful: ffmpeg (for yt-dlp merging), vlc/mpv
# -----------------------------------------------------------------------------
install_optionals() {
  section "Optional tools (ffmpeg, media players)"

  # ffmpeg
  if has ffmpeg; then
    ok "ffmpeg already installed"
  else
    info "ffmpeg is optional but recommended for yt-dlp post-processing."
    read -rp "    Install ffmpeg? [Y/n]: " yn
    if [[ "${yn:-y}" =~ ^[Yy]$ ]]; then
      case "$PLATFORM" in
        termux)  pkg_install "ffmpeg" ffmpeg ;;
        macos)   pkg_install "ffmpeg" ffmpeg ;;
        debian)  pkg_install "ffmpeg" ffmpeg ;;
        fedora)  pkg_install "ffmpeg" ffmpeg --allowerasing 2>/dev/null || \
                   pkg_install "ffmpeg (rpmfusion)" ffmpeg ;;
        arch)    pkg_install "ffmpeg" ffmpeg ;;
        suse)    pkg_install "ffmpeg" ffmpeg ;;
        alpine)  pkg_install "ffmpeg" ffmpeg ;;
      esac
    else
      warn "Skipped ffmpeg"
    fi
  fi

  # VLC
  if [[ "$IS_TERMUX" == false ]]; then
    if has vlc; then
      ok "VLC already installed"
    else
      info "VLC is optional — needed for --player vlc streaming."
      read -rp "    Install VLC? [y/N]: " yn
      if [[ "${yn:-n}" =~ ^[Yy]$ ]]; then
        case "$PLATFORM" in
          macos)   pkg_install "VLC" --cask vlc ;;
          debian)  pkg_install "VLC" vlc ;;
          fedora)  pkg_install "VLC" vlc ;;
          arch)    pkg_install "VLC" vlc ;;
          suse)    pkg_install "VLC" vlc ;;
          alpine)  pkg_install "VLC" vlc ;;
        esac
      else
        warn "Skipped VLC"
      fi
    fi
  fi
}

# -----------------------------------------------------------------------------
# tget itself
# -----------------------------------------------------------------------------
install_tget() {
  section "tget"

  # If run from inside the repo directory, use it
  if [[ -f "$(pwd)/app.js" && -f "$(pwd)/package.json" ]]; then
    info "Installing from current directory..."
    npm install --silent
    npm install -g . --silent
    ok "tget installed from $(pwd)"
    return
  fi

  # Otherwise clone from GitHub
  local clone_dir="${HOME}/.local/share/tget"
  if [[ -d "$clone_dir/.git" ]]; then
    info "Updating existing tget clone..."
    git -C "$clone_dir" pull --quiet
  else
    info "Cloning tget repository..."
    git clone --quiet https://github.com/FusinX/tget.git "$clone_dir"
  fi

  cd "$clone_dir"
  npm install --silent
  npm install -g . --silent
  cd - > /dev/null
  ok "tget installed from GitHub"
}

# -----------------------------------------------------------------------------
# Verify
# -----------------------------------------------------------------------------
verify() {
  section "Verification"

  local all_ok=true

  check_tool() {
    local name="$1" cmd="$2"
    if has "$cmd"; then
      ok "${name}: $(${cmd} --version 2>&1 | head -1)"
    else
      err "${name}: NOT FOUND"
      all_ok=false
    fi
  }

  check_tool "Node.js" node
  check_tool "npm"     npm
  check_tool "tget"    tget
  check_tool "yt-dlp"  yt-dlp

  if has ffmpeg; then
    ok "ffmpeg: $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f1-3)"
  else
    warn "ffmpeg: not installed (optional)"
  fi

  echo ""
  if [[ "$all_ok" == true ]]; then
    echo -e "${G}All required tools installed successfully.${N}"
    echo -e "${C}Run 'tget --help' to get started.${N}"
    echo -e "${C}Run 'tget-gui' to launch the interactive GUI.${N}"
  else
    echo -e "${R}Some tools failed to install. Check errors above.${N}"
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Shell integration — install tget-gui into PATH
# -----------------------------------------------------------------------------
install_gui() {
  local gui_src
  gui_src="$(dirname "$(realpath "$0")")/tget-gui.sh"
  if [[ -f "$gui_src" ]]; then
    if [[ "$IS_TERMUX" == true ]]; then
      cp "$gui_src" "$PREFIX/bin/tget-gui"
      chmod +x "$PREFIX/bin/tget-gui"
    else
      local dest="${HOME}/.local/bin/tget-gui"
      mkdir -p "$(dirname "$dest")"
      cp "$gui_src" "$dest"
      chmod +x "$dest"
    fi
    ok "tget-gui installed to PATH"
  else
    warn "tget-gui.sh not found alongside setup.sh — skipping GUI install"
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  banner
  detect_platform
  check_root
  pkg_update

  install_build_tools
  install_node
  install_ytdlp
  install_optionals
  install_tget
  install_gui
  verify
}

main "$@"
