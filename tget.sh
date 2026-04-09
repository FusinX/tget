#!/usr/bin/env bash
# =============================================================================
# tget-gui.sh — interactive TUI for tget
# Pure bash + ANSI — no dialog/whiptail required. Works on all Linux + Termux.
# =============================================================================

# -----------------------------------------------------------------------------
# Strict mode (no -e so we can handle errors ourselves)
# -----------------------------------------------------------------------------
set -uo pipefail

# -----------------------------------------------------------------------------
# Sanity check
# -----------------------------------------------------------------------------
if ! command -v tget &>/dev/null; then
  echo "tget not found in PATH. Run setup.sh first." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Config file
# -----------------------------------------------------------------------------
CONFIG_DIR="${HOME}/.config/tget"
CONFIG_FILE="${CONFIG_DIR}/gui.conf"
HISTORY_FILE="${CONFIG_DIR}/history"
mkdir -p "$CONFIG_DIR"
touch "$HISTORY_FILE"

# Defaults
CFG_OUTPUT_DIR="${HOME}/Downloads"
CFG_CONNECTIONS=150
CFG_THREADS=4
CFG_PORT=8888
CFG_PREBUFFER=5
CFG_DL_LIMIT=0
CFG_UL_LIMIT=0
CFG_PLAYER=""
CFG_TRACKERS_AUTO=false
CFG_SEED_RATIO=0

load_config() {
  [[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"
}

save_config() {
  cat > "$CONFIG_FILE" << EOF
CFG_OUTPUT_DIR="${CFG_OUTPUT_DIR}"
CFG_CONNECTIONS=${CFG_CONNECTIONS}
CFG_THREADS=${CFG_THREADS}
CFG_PORT=${CFG_PORT}
CFG_PREBUFFER=${CFG_PREBUFFER}
CFG_DL_LIMIT=${CFG_DL_LIMIT}
CFG_UL_LIMIT=${CFG_UL_LIMIT}
CFG_PLAYER="${CFG_PLAYER}"
CFG_TRACKERS_AUTO=${CFG_TRACKERS_AUTO}
CFG_SEED_RATIO=${CFG_SEED_RATIO}
EOF
}

load_config

# -----------------------------------------------------------------------------
# Terminal dimensions (refresh on resize)
# -----------------------------------------------------------------------------
COLS=80
ROWS=24
get_term_size() {
  COLS=$(tput cols  2>/dev/null || echo 80)
  ROWS=$(tput lines 2>/dev/null || echo 24)
}
get_term_size
trap 'get_term_size' WINCH

# -----------------------------------------------------------------------------
# Colour / style constants
# -----------------------------------------------------------------------------
C_RESET=$'\033[0m'
C_BOLD=$'\033[1m'
C_DIM=$'\033[2m'
C_REV=$'\033[7m'       # reverse video — used for selected item

C_BG=$'\033[40m'       # black bg
C_BLACK=$'\033[30m'
C_RED=$'\033[31m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_BLUE=$'\033[34m'
C_MAGENTA=$'\033[35m'
C_CYAN=$'\033[36m'
C_WHITE=$'\033[37m'
C_BWHITE=$'\033[97m'

C_HEADER="${C_BOLD}${C_CYAN}"
C_SELECT="${C_REV}${C_BOLD}${C_WHITE}"
C_NORMAL="${C_RESET}${C_WHITE}"
C_ACCENT="${C_YELLOW}"
C_OK="${C_GREEN}"
C_ERR="${C_RED}"
C_DIM_C="${C_DIM}${C_WHITE}"

# Box-drawing chars (Unicode — works on all modern terminals and Termux)
TL='╔'; TR='╗'; BL='╚'; BR='╝'
H='═'; V='║'
ML='╠'; MR='╣'
MT='╦'; MB='╩'

# -----------------------------------------------------------------------------
# Terminal helpers
# -----------------------------------------------------------------------------
hide_cursor()  { tput civis 2>/dev/null || true; }
show_cursor()  { tput cnorm 2>/dev/null || true; }
clear_screen() { tput clear 2>/dev/null || printf '\033[2J\033[H'; }
move()         { tput cup "$1" "$2" 2>/dev/null || printf "\033[%d;%dH" $(( $1+1 )) $(( $2+1 )); }
clr_line()     { tput el 2>/dev/null || printf '\033[K'; }

# Restore terminal on exit
cleanup_terminal() {
  show_cursor
  tput rmcup 2>/dev/null || true
  tput sgr0  2>/dev/null || true
  echo ""
}
trap cleanup_terminal EXIT INT TERM

# Draw a horizontal box-line of given width
hline() {
  local w="$1" char="${2:-$H}"
  printf '%*s' "$w" '' | tr ' ' "$char"
}

# Centre-pad a string to width w (truncate if too long)
centre() {
  local str="$1" w="$2"
  # Strip ANSI for length measurement
  local plain
  plain=$(echo -e "$str" | sed 's/\x1b\[[0-9;]*m//g')
  local len=${#plain}
  if (( len >= w )); then
    echo "${plain:0:$w}"
    return
  fi
  local pad=$(( (w - len) / 2 ))
  printf '%*s%s%*s' "$pad" '' "$str" $(( w - len - pad )) ''
}

# Pad right to width w
rpad() {
  local str="$1" w="$2"
  local plain
  plain=$(echo -e "$str" | sed 's/\x1b\[[0-9;]*m//g')
  local len=${#plain}
  local needed=$(( w - len ))
  (( needed < 0 )) && needed=0
  printf '%s%*s' "$str" "$needed" ''
}

# -----------------------------------------------------------------------------
# Read a single keypress, returning a named token
# Handles: up/down/left/right arrows, enter, escape, letters
# -----------------------------------------------------------------------------
read_key() {
  local key byte2 byte3
  IFS= read -rsn1 key 2>/dev/null || key=""

  if [[ "$key" == $'\x1b' ]]; then
    # Try reading more bytes with a short timeout
    IFS= read -rsn2 -t 0.15 rest 2>/dev/null || rest=""
    key="${key}${rest}"
  fi

  case "$key" in
    $'\x1b[A'|$'\x1b[OA') echo "UP"    ;;
    $'\x1b[B'|$'\x1b[OB') echo "DOWN"  ;;
    $'\x1b[C'|$'\x1b[OC') echo "RIGHT" ;;
    $'\x1b[D'|$'\x1b[OD') echo "LEFT"  ;;
    $'\x1b[5~')            echo "PGUP"  ;;
    $'\x1b[6~')            echo "PGDN"  ;;
    $'\x1b[H'|$'\x1b[1~') echo "HOME"  ;;
    $'\x1b[F'|$'\x1b[4~') echo "END"   ;;
    $'\n'|$'\r')           echo "ENTER" ;;
    $'\x1b')               echo "ESC"   ;;
    $'\x7f'|$'\x08')       echo "BACK"  ;;
    q|Q)                   echo "q"     ;;
    *)                     echo "$key"  ;;
  esac
}

# -----------------------------------------------------------------------------
# UI: top bar
# -----------------------------------------------------------------------------
draw_topbar() {
  get_term_size
  move 0 0
  local title=" tget — interactive downloader "
  local hint="${C_DIM_C} ↑↓ navigate  enter select  q/esc back ${C_RESET}"
  printf "${C_HEADER}${C_BG}%-${COLS}s${C_RESET}" "$title"
}

# -----------------------------------------------------------------------------
# UI: status bar at the bottom
# -----------------------------------------------------------------------------
STATUS_MSG=""
draw_statusbar() {
  move $(( ROWS - 1 )) 0
  local msg="${STATUS_MSG:-  Ready}"
  printf "${C_DIM}${C_BG}%-${COLS}s${C_RESET}" "$msg"
}

set_status() { STATUS_MSG="  $*"; draw_statusbar; }

# -----------------------------------------------------------------------------
# UI: draw a bordered panel
# Args: top_row left_col height width [title]
# Returns: inner top row, inner left col, inner width (via globals)
# -----------------------------------------------------------------------------
PANEL_INNER_TOP=0
PANEL_INNER_LEFT=0
PANEL_INNER_W=0
PANEL_INNER_H=0

draw_panel() {
  local row="$1" col="$2" h="$3" w="$4" title="${5:-}"

  PANEL_INNER_TOP=$(( row + 1 ))
  PANEL_INNER_LEFT=$(( col + 1 ))
  PANEL_INNER_W=$(( w - 2 ))
  PANEL_INNER_H=$(( h - 2 ))

  # Top border
  move "$row" "$col"
  printf "${C_HEADER}${TL}$(hline $(( w-2 )) "$H")${TR}${C_RESET}"

  # Title centred in top border
  if [[ -n "$title" ]]; then
    local t=" ${title} "
    move "$row" $(( col + (w/2) - (${#title}/2) - 1 ))
    printf "${C_HEADER}${C_BOLD}${t}${C_RESET}"
  fi

  # Sides
  local r
  for (( r=1; r<h-1; r++ )); do
    move $(( row+r )) "$col"
    printf "${C_HEADER}${V}${C_RESET}"
    printf "%-$(( w-2 ))s"  ""          # blank inner
    printf "${C_HEADER}${V}${C_RESET}"
  done

  # Bottom border
  move $(( row+h-1 )) "$col"
  printf "${C_HEADER}${BL}$(hline $(( w-2 )) "$H")${BR}${C_RESET}"
}

# Draw a horizontal divider inside a panel (at relative row r from panel top)
panel_divider() {
  local panel_row="$1" panel_col="$2" panel_w="$3" r="$4"
  move $(( panel_row + r )) "$panel_col"
  printf "${C_HEADER}${ML}$(hline $(( panel_w-2 )) "$H")${MR}${C_RESET}"
}

# -----------------------------------------------------------------------------
# UI: generic scrollable menu
# Items array passed by name (nameref), returns selected index in MENU_RESULT
# -----------------------------------------------------------------------------
MENU_RESULT=-1

menu() {
  local title="$1"
  local -n _items="$2"    # nameref to array
  local start_sel="${3:-0}"

  local count=${#_items[@]}
  local sel=$start_sel
  local scroll=0          # index of topmost visible item

  # Panel geometry
  local pw=$(( COLS > 80 ? 74 : COLS - 6 ))
  local ph=$(( ROWS > 26 ? 22 : ROWS - 4 ))
  local pr=$(( (ROWS - ph) / 2 ))
  local pc=$(( (COLS - pw) / 2 ))
  local visible=$(( ph - 2 ))  # rows available for items (minus title row + hint)

  hide_cursor
  clear_screen
  draw_topbar

  while true; do
    draw_panel "$pr" "$pc" "$ph" "$pw" "$title"

    # Hint row at bottom of panel
    move $(( pr + ph - 2 )) $(( pc + 1 ))
    printf "${C_DIM}%-$(( pw-2 ))s${C_RESET}" \
      "  ↑↓ move  enter select  q back"

    # Divider above hint
    panel_divider "$pr" "$pc" "$pw" $(( ph - 3 ))

    # Adjust scroll window
    (( sel < scroll )) && scroll=$sel
    (( sel >= scroll + visible - 1 )) && scroll=$(( sel - visible + 2 ))
    (( scroll < 0 )) && scroll=0

    # Draw items
    local i
    for (( i=0; i<visible-1; i++ )); do
      local idx=$(( scroll + i ))
      move $(( pr + 1 + i )) $(( pc + 1 ))
      if (( idx >= count )); then
        printf "%-$(( pw-2 ))s" ""
        continue
      fi
      local prefix="  "
      local item="${_items[$idx]}"
      if (( idx == sel )); then
        printf "${C_SELECT}${C_BG}%-$(( pw-2 ))s${C_RESET}" "  ${item}  "
      else
        printf "${C_NORMAL}%-$(( pw-2 ))s${C_RESET}" "${prefix}${item}"
      fi
    done

    # Scroll indicators
    if (( scroll > 0 )); then
      move $(( pr + 1 )) $(( pc + pw - 2 ))
      printf "${C_ACCENT}▲${C_RESET}"
    fi
    if (( scroll + visible - 1 < count )); then
      move $(( pr + ph - 4 )) $(( pc + pw - 2 ))
      printf "${C_ACCENT}▼${C_RESET}"
    fi

    draw_statusbar

    local k
    k=$(read_key)
    case "$k" in
      UP)
        (( sel > 0 )) && (( sel-- )) ;;
      DOWN)
        (( sel < count-1 )) && (( sel++ )) ;;
      HOME)  sel=0 ;;
      END)   sel=$(( count-1 )) ;;
      PGUP)  (( sel -= (visible-2) )); (( sel < 0 )) && sel=0 ;;
      PGDN)  (( sel += (visible-2) )); (( sel >= count )) && sel=$(( count-1 )) ;;
      ENTER) MENU_RESULT=$sel; return 0 ;;
      ESC|q) MENU_RESULT=-1;  return 1 ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# UI: prompt for single-line input
# Returns value in INPUT_RESULT
# -----------------------------------------------------------------------------
INPUT_RESULT=""

prompt_input() {
  local label="$1" default="${2:-}" hint="${3:-}"
  local value="$default"
  local cursor_pos=${#value}

  local pw=$(( COLS > 80 ? 70 : COLS - 8 ))
  local ph=9
  local pr=$(( (ROWS - ph) / 2 ))
  local pc=$(( (COLS - pw) / 2 ))
  local iw=$(( pw - 4 ))

  show_cursor
  clear_screen
  draw_topbar

  draw_panel "$pr" "$pc" "$ph" "$pw" "Input"

  move $(( pr + 2 )) $(( pc + 2 ))
  printf "${C_ACCENT}${C_BOLD}%-$(( pw-4 ))s${C_RESET}" "$label"

  if [[ -n "$hint" ]]; then
    move $(( pr + 3 )) $(( pc + 2 ))
    printf "${C_DIM}%-$(( pw-4 ))s${C_RESET}" "$hint"
  fi

  if [[ -n "$default" ]]; then
    move $(( pr + 4 )) $(( pc + 2 ))
    printf "${C_DIM}default: ${default}${C_RESET}"
  fi

  panel_divider "$pr" "$pc" "$pw" $(( ph - 3 ))
  move $(( pr + ph - 2 )) $(( pc + 2 ))
  printf "${C_DIM}enter confirm  esc cancel${C_RESET}"

  # Input box outline
  move $(( pr + 5 )) $(( pc + 2 ))
  printf "${C_CYAN}┌$(hline $(( iw-2 )) '─')┐${C_RESET}"
  move $(( pr + 6 )) $(( pc + 2 ))
  printf "${C_CYAN}│%-$(( iw-2 ))s│${C_RESET}" ""
  move $(( pr + 7 )) $(( pc + 2 ))
  printf "${C_CYAN}└$(hline $(( iw-2 )) '─')┘${C_RESET}"

  while true; do
    move $(( pr + 6 )) $(( pc + 3 ))
    local disp="${value}"
    # Show only last iw-4 chars if longer
    local dlen=${#disp}
    if (( dlen > iw-4 )); then
      disp="${disp:$(( dlen - (iw-4) ))}"
    fi
    printf "${C_BWHITE}%-$(( iw-4 ))s${C_RESET}" "$disp"
    # Position cursor
    local cpos=$(( pc + 3 + (dlen > iw-4 ? iw-4 : cursor_pos) ))
    move $(( pr + 6 )) "$cpos"

    local k
    k=$(read_key)
    case "$k" in
      ENTER)
        [[ -z "$value" && -n "$default" ]] && value="$default"
        INPUT_RESULT="$value"
        hide_cursor
        return 0 ;;
      ESC)
        INPUT_RESULT=""
        hide_cursor
        return 1 ;;
      BACK)
        if (( cursor_pos > 0 )); then
          value="${value:0:$(( cursor_pos-1 ))}${value:$cursor_pos}"
          (( cursor_pos-- ))
        fi ;;
      LEFT)
        (( cursor_pos > 0 )) && (( cursor_pos-- )) ;;
      RIGHT)
        (( cursor_pos < ${#value} )) && (( cursor_pos++ )) ;;
      *)
        if [[ ${#k} -eq 1 && "$k" != $'\x1b' ]]; then
          value="${value:0:$cursor_pos}${k}${value:$cursor_pos}"
          (( cursor_pos++ ))
        fi ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# UI: yes/no confirm
# Returns 0 for yes, 1 for no
# -----------------------------------------------------------------------------
confirm() {
  local msg="$1" default="${2:-y}"
  local sel=0
  [[ "$default" == "n" ]] && sel=1

  local pw=44 ph=7
  local pr=$(( (ROWS - ph) / 2 ))
  local pc=$(( (COLS - pw) / 2 ))

  hide_cursor
  while true; do
    draw_panel "$pr" "$pc" "$ph" "$pw" "Confirm"
    move $(( pr + 2 )) $(( pc + 2 ))
    printf "${C_BWHITE}%-$(( pw-4 ))s${C_RESET}" "$msg"

    move $(( pr + 4 )) $(( pc + (pw/2) - 7 ))
    if (( sel == 0 )); then
      printf "${C_SELECT}  Yes  ${C_RESET}  ${C_NORMAL}  No   ${C_RESET}"
    else
      printf "${C_NORMAL}  Yes  ${C_RESET}  ${C_SELECT}  No   ${C_RESET}"
    fi

    draw_statusbar
    local k
    k=$(read_key)
    case "$k" in
      LEFT|RIGHT|h|l) (( sel = 1 - sel )) ;;
      ENTER) return $sel ;;
      y|Y)   return 0 ;;
      n|N)   return 1 ;;
      ESC|q) return 1 ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# UI: command preview + run
# -----------------------------------------------------------------------------
run_command() {
  local cmd="$1"
  show_cursor
  clear_screen
  draw_topbar

  local pw=$(( COLS - 4 ))
  local pr=2
  local pc=2

  move $(( pr + 0 )) "$pc"
  printf "${C_ACCENT}${C_BOLD}Command:${C_RESET}\n\n"
  move $(( pr + 1 )) $(( pc + 2 ))
  printf "${C_CYAN}%s${C_RESET}\n\n" "$cmd"
  move $(( pr + 3 )) "$pc"
  printf "${C_DIM}─────────────────────────────────────────────────────${C_RESET}\n"
  move $(( pr + 4 )) "$pc"

  # Restore terminal state before handing to tget
  tput rmcup 2>/dev/null || true
  show_cursor
  echo -e "${C_BOLD}${C_GREEN}Running...${C_RESET}\n"

  # Execute — user sees live output
  eval "$cmd" || true

  echo ""
  echo -e "${C_DIM}────────── finished — press any key ──────────${C_RESET}"
  read -rsn1 _

  # Re-enter alternate screen
  tput smcup 2>/dev/null || true
  hide_cursor

  # Log to history
  echo "$(date '+%Y-%m-%d %H:%M')  ${cmd}" >> "$HISTORY_FILE"
}

# -----------------------------------------------------------------------------
# Build the base tget flags from current config
# -----------------------------------------------------------------------------
base_flags() {
  local f="-o \"${CFG_OUTPUT_DIR}\""
  f+=" -c ${CFG_CONNECTIONS}"
  f+=" --threads ${CFG_THREADS}"
  f+=" --port ${CFG_PORT}"
  [[ "$CFG_TRACKERS_AUTO" == true ]] && f+=" --trackers-auto"
  [[ "$CFG_DL_LIMIT" -gt 0 ]]       && f+=" --download-limit ${CFG_DL_LIMIT}"
  [[ "$CFG_UL_LIMIT" -gt 0 ]]       && f+=" --upload-limit ${CFG_UL_LIMIT}"
  echo "$f"
}

# -----------------------------------------------------------------------------
# Screens
# -----------------------------------------------------------------------------

# ── Quick Download ────────────────────────────────────────────────────────────
screen_quick() {
  prompt_input \
    "Paste magnet link, .torrent path, or any URL:" \
    "" \
    "Auto-detects torrents, HTTP files, and media URLs"
  [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && return

  local target="$INPUT_RESULT"
  local flags
  flags=$(base_flags)
  run_command "tget ${flags} '${target}'"
}

# ── Torrent Download ──────────────────────────────────────────────────────────
screen_torrent() {
  local items=(
    "Download  — full torrent"
    "Download  — select specific files"
    "List files inside torrent"
    "Stream + save  (requires --player or manual VLC)"
    "Stream only  (RAM, no disk write)"
    "Seed after download"
    "Back"
  )

  while true; do
    menu "Torrent" items
    [[ $MENU_RESULT -eq -1 || $MENU_RESULT -eq 6 ]] && return

    case $MENU_RESULT in
      0) # Full download
        prompt_input "Magnet link or .torrent file path:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local target="$INPUT_RESULT"
        run_command "tget $(base_flags) '${target}'"
        ;;

      1) # Select files
        prompt_input "Magnet link or .torrent path:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local target="$INPUT_RESULT"

        set_status "Fetching file list..."
        local tmp_out
        tmp_out=$(mktemp)
        tput rmcup 2>/dev/null || true
        show_cursor
        echo -e "\n${C_CYAN}Fetching file list...${C_RESET}"
        tget "$(base_flags)" --list "$target" 2>/dev/null | tee "$tmp_out" || true
        tput smcup 2>/dev/null || true
        hide_cursor

        prompt_input \
          "Enter file indices to download (e.g. 0,2,3):" \
          "" \
          "Use the indices shown above"
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local sel="$INPUT_RESULT"
        rm -f "$tmp_out"
        run_command "tget $(base_flags) --select ${sel} '${target}'"
        ;;

      2) # List only
        prompt_input "Magnet link or .torrent path:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        run_command "tget '${INPUT_RESULT}' --list"
        ;;

      3) # Stream + save
        prompt_input "Magnet link:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local target="$INPUT_RESULT"
        local player="${CFG_PLAYER}"
        if [[ -z "$player" ]]; then
          prompt_input "Player binary (vlc / mpv / leave blank):" "vlc" ""
          player="${INPUT_RESULT:-}"
        fi
        local player_flag=""
        [[ -n "$player" ]] && player_flag="--player ${player}"
        run_command "tget $(base_flags) --stream --prebuffer ${CFG_PREBUFFER} ${player_flag} '${target}'"
        ;;

      4) # Stream only
        prompt_input "Magnet link:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local target="$INPUT_RESULT"
        local player="${CFG_PLAYER}"
        if [[ -z "$player" ]]; then
          prompt_input "Player binary (vlc / mpv / leave blank):" "mpv" ""
          player="${INPUT_RESULT:-}"
        fi
        local player_flag=""
        [[ -n "$player" ]] && player_flag="--player ${player}"
        run_command "tget $(base_flags) --stream-only --prebuffer ${CFG_PREBUFFER} ${player_flag} '${target}'"
        ;;

      5) # Seed
        prompt_input "Magnet link:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local target="$INPUT_RESULT"
        local ratio_items=("Seed indefinitely" "Seed to ratio" "Back")
        menu "Seeding mode" ratio_items
        case $MENU_RESULT in
          0) run_command "tget $(base_flags) --seed '${target}'" ;;
          1)
            prompt_input "Upload ratio target (e.g. 1.5):" "${CFG_SEED_RATIO}" ""
            [[ $? -ne 0 ]] && continue
            run_command "tget $(base_flags) --seed-ratio ${INPUT_RESULT} '${target}'"
            ;;
        esac
        ;;
    esac
  done
}

# ── HTTP Download ──────────────────────────────────────────────────────────────
screen_http() {
  local items=(
    "Single URL"
    "Multiple URLs  (one per line)"
    "Override output filename"
    "Back"
  )

  while true; do
    menu "HTTP / HTTPS Download" items
    [[ $MENU_RESULT -eq -1 || $MENU_RESULT -eq 3 ]] && return

    case $MENU_RESULT in
      0) # Single URL
        prompt_input "URL:" "" "Supports HTTP/HTTPS with resume and multi-segment"
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        run_command "tget $(base_flags) '${INPUT_RESULT}'"
        ;;

      1) # Multiple URLs
        show_cursor
        clear_screen
        draw_topbar
        echo ""
        echo -e "${C_ACCENT}  Enter URLs one per line. Empty line when done:${C_RESET}"
        echo ""
        local urls=()
        while IFS= read -r line; do
          [[ -z "$line" ]] && break
          urls+=("$line")
        done
        hide_cursor
        if [[ ${#urls[@]} -gt 0 ]]; then
          local url_args=""
          for u in "${urls[@]}"; do
            url_args+=" '${u}'"
          done
          run_command "tget $(base_flags)${url_args}"
        fi
        ;;

      2) # Override filename
        prompt_input "URL:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local url="$INPUT_RESULT"
        prompt_input "Output filename:" "" "Leave blank to auto-detect"
        local fname="${INPUT_RESULT:-}"
        local fn_flag=""
        [[ -n "$fname" ]] && fn_flag="--filename '${fname}'"
        run_command "tget $(base_flags) ${fn_flag} '${url}'"
        ;;
    esac
  done
}

# ── Media Download (yt-dlp) ────────────────────────────────────────────────────
screen_media() {
  if ! command -v yt-dlp &>/dev/null; then
    confirm "yt-dlp not found. Run setup.sh to install it. OK?" "y"
    return
  fi

  local items=(
    "Download video (best quality)"
    "Download audio only (mp3)"
    "Download with custom filename"
    "Back"
  )

  while true; do
    menu "Media Download — via yt-dlp" items
    [[ $MENU_RESULT -eq -1 || $MENU_RESULT -eq 3 ]] && return

    case $MENU_RESULT in
      0) # Video
        prompt_input \
          "Media URL:" "" \
          "YouTube, Vimeo, Twitter/X, Instagram, Reddit, Twitch..."
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        run_command "tget $(base_flags) '${INPUT_RESULT}'"
        ;;

      1) # Audio only — pass via yt-dlp directly since tget delegates to it
        prompt_input "Media URL:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        run_command "yt-dlp -x --audio-format mp3 -o '${CFG_OUTPUT_DIR}/%(title)s.%(ext)s' '${INPUT_RESULT}'"
        ;;

      2) # Custom filename
        prompt_input "Media URL:" "" ""
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        local url="$INPUT_RESULT"
        prompt_input "Output filename (with extension):" "" "e.g. lecture.mp4"
        [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && continue
        run_command "tget $(base_flags) --filename '${INPUT_RESULT}' '${url}'"
        ;;
    esac
  done
}

# ── JSON / Scripting mode ──────────────────────────────────────────────────────
screen_json() {
  prompt_input "Magnet or URL for JSON output:" "" "Pipe into jq or custom dashboard"
  [[ $? -ne 0 || -z "$INPUT_RESULT" ]] && return
  run_command "tget $(base_flags) --json '${INPUT_RESULT}' | jq ."
}

# ── History ────────────────────────────────────────────────────────────────────
screen_history() {
  local lines=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && lines+=("$line")
  done < <(tail -30 "$HISTORY_FILE" 2>/dev/null)

  if [[ ${#lines[@]} -eq 0 ]]; then
    confirm "No download history yet." "y"
    return
  fi

  # Reverse to show newest first
  local rev_lines=()
  for (( i=${#lines[@]}-1; i>=0; i-- )); do
    rev_lines+=("${lines[$i]}")
  done
  rev_lines+=("── Clear history ──" "Back")

  menu "Download History (last 30)" rev_lines
  case $MENU_RESULT in
    -1) return ;;
    *)
      local chosen="${rev_lines[$MENU_RESULT]}"
      if [[ "$chosen" == "── Clear history ──" ]]; then
        confirm "Clear all history?" "n" && { > "$HISTORY_FILE"; set_status "History cleared."; }
      elif [[ "$chosen" != "Back" ]]; then
        # Strip timestamp prefix
        local cmd="${chosen:18}"
        confirm "Re-run this command?" "y" && run_command "$cmd"
      fi ;;
  esac
}

# ── Settings ───────────────────────────────────────────────────────────────────
screen_settings() {
  while true; do
    local items=(
      "Output directory       ${C_ACCENT}${CFG_OUTPUT_DIR}${C_RESET}"
      "Connections (torrent)  ${C_ACCENT}${CFG_CONNECTIONS}${C_RESET}"
      "HTTP segments          ${C_ACCENT}${CFG_THREADS}${C_RESET}"
      "Stream port            ${C_ACCENT}${CFG_PORT}${C_RESET}"
      "Prebuffer (MB)         ${C_ACCENT}${CFG_PREBUFFER}${C_RESET}"
      "Download limit MB/s    ${C_ACCENT}$(( CFG_DL_LIMIT == 0 ? 0 : CFG_DL_LIMIT )) (0=unlimited)${C_RESET}"
      "Upload limit MB/s      ${C_ACCENT}$(( CFG_UL_LIMIT == 0 ? 0 : CFG_UL_LIMIT )) (0=unlimited)${C_RESET}"
      "Default player         ${C_ACCENT}${CFG_PLAYER:-none}${C_RESET}"
      "Auto-fetch trackers    ${C_ACCENT}${CFG_TRACKERS_AUTO}${C_RESET}"
      "Reset to defaults"
      "Back"
    )

    menu "Settings" items

    case $MENU_RESULT in
      -1|10) save_config; return ;;
      0)
        prompt_input "Output directory:" "$CFG_OUTPUT_DIR" ""
        [[ $? -eq 0 && -n "$INPUT_RESULT" ]] && CFG_OUTPUT_DIR="$INPUT_RESULT"
        ;;
      1)
        prompt_input "Max peer connections:" "$CFG_CONNECTIONS" "Recommended: 50–300"
        [[ $? -eq 0 && -n "$INPUT_RESULT" ]] && CFG_CONNECTIONS="$INPUT_RESULT"
        ;;
      2)
        prompt_input "HTTP download segments:" "$CFG_THREADS" "Parallel segments (1–16)"
        [[ $? -eq 0 && -n "$INPUT_RESULT" ]] && CFG_THREADS="$INPUT_RESULT"
        ;;
      3)
        prompt_input "Stream server port:" "$CFG_PORT" ""
        [[ $? -eq 0 && -n "$INPUT_RESULT" ]] && CFG_PORT="$INPUT_RESULT"
        ;;
      4)
        prompt_input "Prebuffer MB:" "$CFG_PREBUFFER" "Data buffered before stream URL shown"
        [[ $? -eq 0 && -n "$INPUT_RESULT" ]] && CFG_PREBUFFER="$INPUT_RESULT"
        ;;
      5)
        prompt_input "Download limit MB/s (0=unlimited):" "$CFG_DL_LIMIT" ""
        [[ $? -eq 0 && -n "$INPUT_RESULT" ]] && CFG_DL_LIMIT="$INPUT_RESULT"
        ;;
      6)
        prompt_input "Upload limit MB/s (0=unlimited):" "$CFG_UL_LIMIT" ""
        [[ $? -eq 0 && -n "$INPUT_RESULT" ]] && CFG_UL_LIMIT="$INPUT_RESULT"
        ;;
      7)
        prompt_input "Default player (vlc/mpv/leave blank):" "$CFG_PLAYER" ""
        [[ $? -eq 0 ]] && CFG_PLAYER="$INPUT_RESULT"
        ;;
      8)
        if [[ "$CFG_TRACKERS_AUTO" == true ]]; then
          CFG_TRACKERS_AUTO=false
        else
          CFG_TRACKERS_AUTO=true
        fi
        ;;
      9) # Reset defaults
        if confirm "Reset all settings to defaults?" "n"; then
          CFG_OUTPUT_DIR="${HOME}/Downloads"
          CFG_CONNECTIONS=150
          CFG_THREADS=4
          CFG_PORT=8888
          CFG_PREBUFFER=5
          CFG_DL_LIMIT=0
          CFG_UL_LIMIT=0
          CFG_PLAYER=""
          CFG_TRACKERS_AUTO=false
          CFG_SEED_RATIO=0
          set_status "Settings reset to defaults."
        fi
        ;;
    esac

    save_config
  done
}

# ── About / Help ───────────────────────────────────────────────────────────────
screen_about() {
  clear_screen
  draw_topbar
  local pw=$(( COLS > 80 ? 76 : COLS - 4 ))
  local ph=$(( ROWS - 4 ))
  local pr=2
  local pc=$(( (COLS - pw) / 2 ))

  draw_panel "$pr" "$pc" "$ph" "$pw" "About tget"

  local row=$(( pr + 2 ))
  local c=$(( pc + 3 ))

  move $row $c; printf "${C_BOLD}${C_CYAN}tget v3.0${C_RESET}  —  wget for torrents + HTTP downloader"
  (( row += 2 ))
  move $row $c; printf "${C_ACCENT}Keyboard shortcuts (while tget is running):${C_RESET}"
  (( row++ ))
  move $row $c; printf "  P          Pause / Resume download"
  (( row++ ))
  move $row $c; printf "  L          Toggle peer connection log"
  (( row++ ))
  move $row $c; printf "  Ctrl+C     Graceful exit (saves progress)"
  (( row += 2 ))
  move $row $c; printf "${C_ACCENT}Supported input types:${C_RESET}"
  (( row++ ))
  move $row $c; printf "  magnet:…   BitTorrent magnet link"
  (( row++ ))
  move $row $c; printf "  file.torrent  Local .torrent file"
  (( row++ ))
  move $row $c; printf "  https://…  HTTP/HTTPS direct file download"
  (( row++ ))
  move $row $c; printf "  youtube.com, vimeo, twitter/x, instagram,"
  (( row++ ))
  move $row $c; printf "  reddit, twitch, tiktok, soundcloud → yt-dlp"
  (( row += 2 ))
  move $row $c; printf "${C_ACCENT}Config file:${C_RESET}   ${CONFIG_FILE}"
  (( row++ ))
  move $row $c; printf "${C_ACCENT}History:${C_RESET}       ${HISTORY_FILE}"
  (( row += 2 ))
  move $row $c; printf "${C_DIM}Press any key to return...${C_RESET}"

  draw_statusbar
  read -rsn1 _
}

# -----------------------------------------------------------------------------
# Main menu
# -----------------------------------------------------------------------------
main_menu() {
  tput smcup 2>/dev/null || true
  hide_cursor

  local items=(
    "  Quick Download       auto-detect any input"
    "  Torrent              magnet / .torrent file"
    "  HTTP / HTTPS File    direct file download"
    "  Media                YouTube, Vimeo, Twitch…"
    "  JSON / Script mode   machine-readable output"
    "  History              recent downloads"
    "──────────────────────────────────────────"
    "  Settings"
    "  About & Help"
    "──────────────────────────────────────────"
    "  Quit"
  )

  # Map display indices to handlers (skip separators)
  while true; do
    menu " tget — main menu " items 0
    case $MENU_RESULT in
      -1|10) break ;;
      0)  screen_quick ;;
      1)  screen_torrent ;;
      2)  screen_http ;;
      3)  screen_media ;;
      4)  screen_json ;;
      5)  screen_history ;;
      6)  : ;; # separator — no-op
      7)  screen_settings ;;
      8)  screen_about ;;
      9)  : ;; # separator — no-op
    esac
  done

  clear_screen
  show_cursor
  echo -e "${C_CYAN}tget-gui closed.${C_RESET}"
}

# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------
main_menu
