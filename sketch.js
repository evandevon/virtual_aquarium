/* =========================================================================
   CLASSROOM AQUARIUM   —   v1.4
   - Draw a fish on paper -> scan with webcam, OR paste an image, OR upload one.
   - Images route through the previewer for background removal, then "Capture".
   - Fish swim, occasionally dart and tilt.
   - Press a fish to catch it; quick release flips it, long press deletes it.
   - Backup / restore the tank as a ZIP.

   VERSION: bump this on each change. Keep it in sync with the comment in index.html.
   ========================================================================= */
const VERSION = "v1.8";

// ---- Mask / preview buffer size (kept small for speed) ----
const panelW = 320;
const panelH = 240;

// ---- Left-column preview sizes ----
const previewW = 220;
const previewH = 160;
const previewMargin = 10;

// ---- Fish image cropping target (keeps files & memory small) ----
const MAX_FISH_IMG_EDGE = 140; // stored image longest edge, px

// ---- Interaction ----
const LONG_PRESS_MS = 550;     // hold this long to delete a caught fish
const ALPHA_HIT = 24;          // a tap registers only on image pixels at/above this alpha

// ---- Feeding ----
const MOVE_THRESH = 16;        // px of movement that turns a press into a drag
const FOOD_HOLD_MS = 700;      // stationary hold on water before food drops
const FOOD_BURST = 6;          // flakes dropped the moment feeding starts
const FOOD_TRICKLE_EVERY = 10; // frames between trickle flakes while holding
const FOOD_MAX = 60;           // total flakes alive at once (perf cap)
const SEEK_RADIUS = 150;       // how far a fish notices food
const SATIATED_FRAMES = 300;   // ~5s a fish ignores food after a bite
const GROW_PER_FEED = 1.08;    // size step per flake eaten
const FEED_MAX = 2.0;          // feeding tops out at 2x adult size

// ---- Size / growing up ----
const FISH_START_SCALE = 1.2;  // adult size of brand-new (scanned) fish
const BABY_START = 0.35;       // a baby starts at this fraction of adult size
const MATURE_FRAMES = 60 * 90; // ~90s for a baby to grow up

// ---- Movement feel ----
const TURN_EASE = 0.05;        // how softly fish arc when turning (higher = quicker)
const LEAN_WANDER = 0.14;      // gentle baseline up/down lean while drifting (radians)
const LEAN_EDGE = 0.45;        // lean used to steer away from top/bottom
const PITCH_SEEK = 0.7;        // steeper lean allowed when chasing food / hiding
const SIDE_MARGIN = 130;       // how early a fish starts its turn near a side wall
const TURN_MIN_FRAMES = 420;   // a drifting fish considers a plain turn this often
const TURN_MAX_FRAMES = 900;
const TURN_CHANCE = 0.35;

// ---- Flourishes (brief random moves; only a couple happen at once) ----
const MAX_FLOURISH = 2;        // max fish doing a flourish at the same time
const FLOURISH_CHECK = 90;     // frames between "should someone flourish?" checks
const FLOURISH_CHANCE = 0.5;   // chance to start one when below the cap
const FLOURISH_MIN = 150;      // duration range for timed flourishes (frames)
const FLOURISH_MAX = 320;
const LEAN_STRONG = 0.5;       // steep lean for rise/dive flourishes
const LOOP_SPEED = 0.045;      // radians/frame for the loop flourish

// ---- Feeding focus ----
const FRONT_EAT_DEPTH = 0.15;  // a fish must be this close to the front to eat
const SEEK_DEPTH_EASE = 0.03;  // how quickly an attracted fish comes forward

// ---- Bubbles ----
const BUBBLE_SPAWN_EVERY = 24; // frames between bubbles (higher = fewer bubbles)
const BUBBLE_SPEED_SCALE = 0.7; // rise speed multiplier (lower = slower)

// ---- Reproduction & gentle thinning (calm, not fed-triggered) ----
const SOFT_TARGET = 16;        // tank drifts toward this many fish
const REPRO_MIN_MS = 60 * 1000;   // a baby appears somewhere every 1–2.5 min
const REPRO_MAX_MS = 150 * 1000;
const TRAIL_DIST = 75;         // how far a baby lags behind its parent

// ---- Depth (parallax layers) ----
const DEPTH_LAYERS = 10;       // number of depth bands
const DEPTH_BACK_SCALE = 0.55; // size of the furthest fish vs nearest
// Far fish keep their opacity now; depth reads as a cooler, muted tint instead
// of a fade. Tint is multiplicative, so it pulls colours toward these targets
// (R dropped most, B kept highest) — saturated fish read "cooler/dimmer" rather
// than truly desaturated, which is the expected limit of a single tint pass.
const DEPTH_TINT_R = 120;      // furthest fish: red knocked back hardest
const DEPTH_TINT_G = 175;
const DEPTH_TINT_B = 225;      // blue preserved -> the receding-into-water look

// ---- Shark (calm visitor) ----
const SHARK_INTERVAL_MS = 5 * 60 * 1000; // a shark passes ~every 5 minutes
const SHARK_SCARE_RADIUS = 650;          // fish notice it from far away
const SHARK_SPEED = 0.8;                 // px/frame (slow, unhurried)
const SHARK_SCALE = 1.5;                 // overall shark size multiplier

// ---- Idle display mode ----
const IDLE_MS = 150 * 1000;    // hide the UI after this long with no interaction

// ---- Foreground rocks & coral ----
const FOREGROUND_SCALE = 1.5;  // size of the rocks/coral clusters

let appState = "intro";        // "intro" | "running"

// Assets
let bgImg, bgMusic;
let splashSounds = [];
let assetsReady = { bg: false, music: false, splash: [false, false, false] };

// Webcam + previewer
let video, videoSelect;
let previewImage;              // p5.Image holding the current mask result
let thresholdSlider;
let previewMode = "live";      // "live" | "static"
let staticPixels = null;       // cached pixels for a pasted/uploaded image
let staticHasAlpha = false;
let lastSentThreshold = -1;

// Worker
let maskWorker;
let maskUpdateInProgress = false;

// Fish + effects
let fishArray = [];
let bubbles = [];
let popBubbles = [];
let food = [];                 // sinking flakes
let shark = null;
let nextSharkMs = Infinity;
let nextReproMs = Infinity;     // next random baby
let fishSeq = 0;                // ever-increasing id, for "oldest" thinning
let shelters = [];             // procedural foreground rocks/coral
let bubbleSprite = null;       // cached soft-bubble image (perf)

// Idle display mode
let idle = false;
let lastActivityMs = 0;

// Preview transform applied before capture (rotate-right / flip H / flip V)
let previewTransform = { rot: 0, flipH: false, flipV: false };

// Press state (one gesture at a time). Locked to a target at press time.
// press = { kind:'fish'|'water', startMs, x, y, moved, fed, fish }
let press = null;

// DOM controls (so we can show/hide and re-layout)
let controls = [];
let captureBtn, uploadImgBtn, pasteBtn, backupBtn, restoreBtn, muteBtn;
let rotateBtn, flipHBtn, flipVBtn;     // overlaid on the preview
let musicLinkBtn, musicToggleBtn, musicInput, musicPlayBtn; // YouTube background music
let imgFileInput, zipFileInput;
let muted = false;

// YouTube background music (plays via the official embedded player, picture hidden)
//
// >>> DEFAULT TRACK: paste a YouTube link between the quotes to set a default
//     backing track. Accepts youtube.com/watch?v=…, youtu.be/…, or a bare ID.
//     It pre-fills the music box, so a teacher can just press Music then Play
//     (no typing) to start it. Leave it "" for no default.
const DEFAULT_MUSIC_URL = "www.youtube.com/watch?v=g9c2WTCj0Pk";
let ytPlayer = null;
let ytPlaying = false;
let lastPasteMs = -9999;       // de-dupe between the paste event and Ctrl+V fallback

// Backup libs (lazy-loaded)
let libsLoaded = false;

// ============================ PRELOAD ====================================
function preload() {
  bgImg = loadImage("assets/reef.jpg",
    () => { assetsReady.bg = true; },
    () => { console.warn("reef.jpg not found yet"); });

  bgMusic = loadSound("assets/ambience.mp3",
    () => { assetsReady.music = true; },
    () => { console.warn("ambience.mp3 not found yet"); });

  for (let i = 0; i < 3; i++) {
    const idx = i;
    splashSounds[i] = loadSound(`assets/splash_${i + 1}.mp3`,
      () => { assetsReady.splash[idx] = true; },
      () => { console.warn(`splash_${idx + 1}.mp3 not found yet`); });
  }
}

// ============================ SETUP ======================================
function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  frameRate(60);
  imageMode(CORNER);

  // Stop the right-click / long-press context menu (and iOS callout) so a
  // stationary hold-to-feed isn't hijacked by the browser.
  cnv.elt.addEventListener("contextmenu", (e) => e.preventDefault());
  cnv.elt.style.touchAction = "none";

  previewImage = createImage(panelW, panelH);
  bubbleSprite = makeBubbleSprite();   // render the soft bubble once, reuse it
  createMaskWorker();
  startPreviewUpdateLoop();

  buildControls();
  layoutControls();
  showControls(false); // hidden until intro is dismissed

  // Paste-an-image support (works on a standalone page, not inside an iframe)
  window.addEventListener("paste", handlePaste);
}

// First user gesture: unlock audio, start ambience + webcam, enter running state.
function startApp() {
  appState = "running";
  showControls(true);

  if (typeof userStartAudio === "function") userStartAudio();
  if (assetsReady.music && bgMusic) {
    bgMusic.setVolume(0.3);
    bgMusic.loop();
  }
  startVideo(); // triggers camera permission, then we enumerate devices

  buildForeground(aquarium());          // procedural rocks/coral, unique each load
  nextSharkMs = millis() + SHARK_INTERVAL_MS;
  nextReproMs = millis() + random(REPRO_MIN_MS, REPRO_MAX_MS);
  lastActivityMs = millis();
}

// Idle display mode: hide the UI and let the tank fill the screen.
function wake() {
  lastActivityMs = millis();
  if (idle) setIdle(false);
}

function setIdle(state) {
  if (idle === state || appState !== "running") return;
  const oldW = aquarium().w;
  idle = state;
  const newW = aquarium().w;
  const fx = newW / oldW;
  for (const f of fishArray) { f.x *= fx; f.hideX *= fx; } // keep relative positions
  buildForeground(aquarium());
  showControls(!state);
  if (!state) layoutControls();
}

// ============================ CONTROLS ===================================
function buildControls() {
  thresholdSlider = createSlider(0, 255, 180);

  videoSelect = createSelect();
  videoSelect.changed(() => startVideo(videoSelect.value()));

  captureBtn = createButton("📸  Capture Fish");
  captureBtn.elt.classList.add("primary-btn");
  captureBtn.mousePressed(captureFish);

  uploadImgBtn = createButton("🖼  Upload");
  uploadImgBtn.mousePressed(() => { imgFileInput.elt.value = ""; imgFileInput.elt.click(); });

  pasteBtn = createButton("📋  Paste");
  pasteBtn.attribute("title", "Paste an image (or press Ctrl+V)");
  pasteBtn.mousePressed(pasteFromClipboard);

  backupBtn = createButton("💾  Backup");
  backupBtn.mousePressed(() => {
    if (!libsLoaded) loadLibraries().then(() => { libsLoaded = true; backupFish(); });
    else backupFish();
  });

  restoreBtn = createButton("📂  Restore");
  restoreBtn.mousePressed(() => {
    const open = () => { zipFileInput.elt.value = ""; zipFileInput.elt.click(); };
    if (!libsLoaded) loadLibraries().then(() => { libsLoaded = true; open(); });
    else open();
  });

  muteBtn = createButton("🔊  Sound On");
  muteBtn.mousePressed(toggleMute);

  // YouTube background music: short link button + volume-icon toggle + volume slider.
  musicLinkBtn = createButton("🎵  Music");
  musicLinkBtn.attribute("title", "Add background music from a YouTube link");
  musicLinkBtn.mousePressed(toggleMusicInput);

  musicToggleBtn = createButton("🔇");
  musicToggleBtn.attribute("title", "Turn the music on/off");
  musicToggleBtn.mousePressed(toggleYouTubeMusic);

  musicVolSlider = createSlider(0, 100, 60);
  musicVolSlider.attribute("title", "Music volume");
  musicVolSlider.input(() => { if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(musicVolSlider.value()); });

  musicInput = createInput(DEFAULT_MUSIC_URL);
  musicInput.attribute("placeholder", "Paste a YouTube link…");
  musicInput.style("display", "none");
  musicInput.elt.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startYouTubeMusic(musicInput.value());
  });

  musicPlayBtn = createButton("▶");
  musicPlayBtn.mousePressed(() => startYouTubeMusic(musicInput.value()));
  musicPlayBtn.style("display", "none");

  // Small transform buttons overlaid on the mask preview (applied before capture)
  rotateBtn = createButton("↻");
  rotateBtn.mousePressed(() => { previewTransform.rot = (previewTransform.rot + 1) % 4; });
  flipHBtn = createButton("⇄");
  flipHBtn.mousePressed(() => { previewTransform.flipH = !previewTransform.flipH; });
  flipVBtn = createButton("⇅");
  flipVBtn.mousePressed(() => { previewTransform.flipV = !previewTransform.flipV; });
  for (const b of [rotateBtn, flipHBtn, flipVBtn]) {
    b.style("font-size", "18px");
    b.attribute("title", "Adjust the image before capturing");
  }

  // Hidden native file inputs
  imgFileInput = createFileInput(handleImageFile);
  imgFileInput.attribute("accept", "image/png,image/jpeg");
  imgFileInput.style("display", "none");

  zipFileInput = createFileInput(handleZipFile);
  zipFileInput.attribute("accept", ".zip");
  zipFileInput.style("display", "none");

  controls = [thresholdSlider, videoSelect, captureBtn, uploadImgBtn, pasteBtn,
              backupBtn, restoreBtn, muteBtn, musicLinkBtn, musicToggleBtn,
              musicVolSlider, rotateBtn, flipHBtn, flipVBtn];

  // Keep all DOM controls above the canvas so clicks/focus land on them.
  for (const c of [...controls, musicInput, musicPlayBtn]) c.style("z-index", "5");
}

function layoutControls() {
  const x = previewMargin;
  // Transform buttons sit along the top-right of the mask preview.
  const maskTop = previewMargin + previewH + previewMargin;
  const bs = 32, gap = 4;
  let bx = previewMargin + previewW - (bs * 3 + gap * 2) - 4;
  for (const b of [rotateBtn, flipHBtn, flipVBtn]) {
    b.position(bx, maskTop + 4); b.size(bs, bs); bx += bs + gap;
  }

  let y = previewMargin + previewH;            // below webcam preview
  y += previewMargin + previewH + previewMargin; // below mask preview

  const W = previewW;            // 220
  const H = 34, G = 6;           // compact button height + gap
  const halfW = (W - G) / 2;

  videoSelect.position(x, y); videoSelect.size(W); y += 32;
  thresholdSlider.position(x, y); thresholdSlider.style("width", W + "px"); y += 30;

  captureBtn.position(x, y); captureBtn.size(W, 44); y += 44 + G;

  // Two-up rows
  uploadImgBtn.position(x, y); uploadImgBtn.size(halfW, H);
  pasteBtn.position(x + halfW + G, y); pasteBtn.size(halfW, H); y += H + G;

  backupBtn.position(x, y); backupBtn.size(halfW, H);
  restoreBtn.position(x + halfW + G, y); restoreBtn.size(halfW, H); y += H + G;

  muteBtn.position(x, y); muteBtn.size(W, H); y += H + G;

  // Music: link (wide) + volume-icon toggle, with a volume slider underneath
  const tW = 40;
  musicLinkBtn.position(x, y); musicLinkBtn.size(W - tW - G, H);
  musicToggleBtn.position(x + W - tW, y); musicToggleBtn.size(tW, H); y += H + G;
  musicVolSlider.position(x, y); musicVolSlider.style("width", W + "px"); y += 26;

  // The link entry field pops up along the top of the aquarium.
  const ax = previewW + previewMargin * 2;
  musicInput.position(ax + 12, 14); musicInput.size(width - ax - 80, 30);
  musicPlayBtn.position(width - 56, 12); musicPlayBtn.size(44, 34);

  textBlockY = y + 6; // canvas text starts here
}
let textBlockY = 0;

function showControls(show) {
  const d = show ? "block" : "none";
  for (const c of controls) c.style("display", d);
}

function toggleMute() {
  muted = !muted;
  if (bgMusic) bgMusic.setVolume(muted ? 0 : 0.3);
  muteBtn.html(muted ? "🔇  Sound Off" : "🔊  Sound On");
}

// ============================ YOUTUBE MUSIC ==============================
// Plays a YouTube link through the official embedded player with the picture
// hidden off-screen, so effectively you hear just the audio. Needs YouTube to
// be reachable (may be blocked on school networks) and the video to allow embeds.

function toggleMusicInput() {
  const showing = musicInput.elt.style.display !== "none";
  const d = showing ? "none" : "block";
  // Opening an empty field: bring the default track back so Play just works.
  if (!showing && !musicInput.value()) musicInput.value(DEFAULT_MUSIC_URL);
  musicInput.style("display", d);
  musicPlayBtn.style("display", d);
  if (!showing) musicInput.elt.focus();
}

function parseYouTubeId(url) {
  if (!url) return null;
  url = url.trim();
  const patterns = [/[?&]v=([\w-]{11})/, /youtu\.be\/([\w-]{11})/, /embed\/([\w-]{11})/, /shorts\/([\w-]{11})/];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  if (/^[\w-]{11}$/.test(url)) return url; // bare 11-char id
  return null;
}

function loadYouTubeAPI() {
  return new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = () => resolve();
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => reject(new Error("blocked"));
    document.head.appendChild(tag);
  });
}

async function startYouTubeMusic(url) {
  const id = parseYouTubeId(url);
  if (!id) { alert("Couldn't read that link. Paste a full YouTube URL (youtube.com/watch?v=… or youtu.be/…)."); return; }

  try { await loadYouTubeAPI(); }
  catch (e) { alert("Couldn't reach YouTube — your network may block it. This feature needs YouTube access."); return; }

  // Hidden host element (off-screen so only audio is noticed)
  let host = document.getElementById("yt-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "yt-host";
    host.style.cssText = "position:absolute;left:-10000px;top:0;width:320px;height:180px;";
    document.body.appendChild(host);
  }

  if (ytPlayer) {
    ytPlayer.loadVideoById(id);
    ytPlayer.playVideo();
    ytPlaying = true; updateMusicToggle();
  } else {
    ytPlayer = new YT.Player("yt-host", {
      videoId: id,
      playerVars: { autoplay: 1, controls: 0, loop: 1, playlist: id },
      events: {
        onReady: (e) => {
          e.target.setVolume(musicVolSlider ? musicVolSlider.value() : 60);
          e.target.playVideo(); ytPlaying = true; updateMusicToggle();
        },
        onError: () => alert("That video can't be played here (it may block embedding). Try another link."),
      },
    });
  }
  toggleMusicInput(); // tuck the field away again
}

function toggleYouTubeMusic() {
  if (!ytPlayer) { toggleMusicInput(); return; } // no track yet -> open the field
  if (ytPlaying) { ytPlayer.pauseVideo(); ytPlaying = false; }
  else { ytPlayer.playVideo(); ytPlaying = true; }
  updateMusicToggle();
}

function updateMusicToggle() {
  if (musicToggleBtn) musicToggleBtn.html(ytPlaying ? "🔊" : "🔇");
}

// ============================ WEBCAM =====================================
function startVideo(deviceId) {
  if (video) video.remove();
  const constraints = {
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false,
  };
  video = createCapture(constraints, () => {
    // Once we have permission, populate the camera list.
    navigator.mediaDevices.enumerateDevices().then(gotDevices).catch(() => {});
  });
  video.size(panelW, panelH);
  video.hide();
  previewMode = "live";
}

function gotDevices(deviceInfos) {
  const current = videoSelect.value();
  videoSelect.elt.innerHTML = "";
  let n = 0;
  for (const info of deviceInfos) {
    if (info.kind === "videoinput") {
      videoSelect.option(info.label || `Camera ${++n}`, info.deviceId);
    }
  }
  if (current) videoSelect.selected(current);
}

// ============================ MASK WORKER ================================
function createMaskWorker() {
  const workerCode = `
    self.onmessage = function (e) {
      const { pixels, width, height, threshold, hasAlpha } = e.data;
      const output = new Uint8ClampedArray(pixels.length);

      if (hasAlpha) {
        // Source already has transparency: respect it. Keep opaque pixels
        // (even bright ones), drop transparent ones. No flood-fill, so we
        // never eat into bright areas of a clean cut-out.
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 128) {
            output[i] = pixels[i]; output[i+1] = pixels[i+1];
            output[i+2] = pixels[i+2]; output[i+3] = pixels[i+3];
          } // else stays 0,0,0,0
        }
        self.postMessage({ pixels: output, width, height });
        return;
      }

      // Opaque source (webcam / flat image): white-paper background removal,
      // tuned for kids' drawings under uneven classroom lighting.
      //
      // The signal we trust: real drawing is either genuinely DARK (ink/pencil)
      // or COLOURED (has chroma). A cast shadow on white paper is neither — it's
      // a mid-bright, near-grey region. So the brightness threshold alone (the
      // old approach) kept shadows; here we instead:
      //   1) seed confident "subject" pixels (dark OR chromatic),
      //   2) GROW that seed a few px into faint/anti-aliased neighbours, which
      //      rescues light pencil joined to darker ink  [neighbour weighting],
      //   3) be more forgiving toward the CENTRE (where the fish sits) and
      //      stricter at the edges (where paper + shadow live) [centre weighting],
      //   4) flood the remaining non-subject inward from the borders, so a whole
      //      sheet of paper AND its soft grey shadow wash out, whatever their
      //      absolute brightness — this is what copes with uneven lighting,
      //   5) "open" the kept mask (erode then dilate) to shed thin shadow fringe
      //      and speckle without gnawing the body.
      const N = width * height;

      // The slider drives the dark floor: higher = keep lighter / fainter marks.
      const DARK_FLOOR  = threshold * 0.6;  // brightness <= this = definitely ink
      const SAT_KEEP    = 34;               // chroma >= this = definitely colour
      const WHITE_CUT   = 230;              // never grow the seed into near-white
      const CENTRE_BIAS = 35;               // extra dark-floor allowance at dead centre
      const GROW_PASSES = 3;                // how far the seed creeps along faint marks
      const GROW_NEED_C = 2;                // subject-neighbours needed near centre
      const GROW_NEED_E = 4;                // ...and (more) needed out at the edges
      const OPEN_OFF    = 6;                // erode pixels with >= this many empty neighbours
      const OPEN_ON     = 6;                // dilate back pixels with >= this many full neighbours

      const cx = (width - 1) / 2, cy = (height - 1) / 2;
      const maxR = Math.hypot(cx, cy);
      const idxAt = (x, y) => y * width + x;

      const bright = new Float32Array(N);
      const cw = new Float32Array(N);   // centre weight, 1 at middle -> 0 at corners
      const st = new Uint8Array(N);     // 1 = subject, 0 = candidate (later: 2 = removed bg)

      // 1) Confident seed + per-pixel features.
      for (let i = 0, p = 0; i < N; i++, p += 4) {
        const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2], al = pixels[p + 3];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const br = (r + g + b) / 3;
        bright[i] = br;
        const x = i % width, y = (i / width) | 0;
        let w = 1 - Math.hypot(x - cx, y - cy) / maxR;
        if (w < 0) w = 0;
        cw[i] = w;
        const floor = DARK_FLOOR + CENTRE_BIAS * w;
        st[i] = (al > 128 && ((mx - mn) >= SAT_KEEP || br <= floor)) ? 1 : 0;
      }

      // 2)+3) Grow the seed into faint neighbours, more eagerly toward the centre.
      for (let pass = 0; pass < GROW_PASSES; pass++) {
        const add = [];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = idxAt(x, y);
            if (st[i] !== 0 || bright[i] > WHITE_CUT) continue;
            let n = 0;
            if (x > 0           && st[i - 1])         n++;
            if (x < width - 1   && st[i + 1])         n++;
            if (y > 0           && st[i - width])     n++;
            if (y < height - 1  && st[i + width])     n++;
            if (x > 0 && y > 0                   && st[i - width - 1]) n++;
            if (x < width - 1 && y > 0           && st[i - width + 1]) n++;
            if (x > 0 && y < height - 1          && st[i + width - 1]) n++;
            if (x < width - 1 && y < height - 1  && st[i + width + 1]) n++;
            const need = GROW_NEED_E + (GROW_NEED_C - GROW_NEED_E) * cw[i];
            if (n >= need) add.push(i);
          }
        }
        if (!add.length) break;
        for (let k = 0; k < add.length; k++) st[add[k]] = 1;
      }

      // 4) Flood the remaining candidates in from the borders (paper + its
      // connected shadow) and mark them removed (2).
      const stack = [];
      const seed = (i) => { if (st[i] === 0) { st[i] = 2; stack.push(i); } };
      for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
      for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
      while (stack.length) {
        const idx = stack.pop();
        const px = idx % width, py = (idx / width) | 0;
        if (px > 0          && st[idx - 1] === 0)     { st[idx - 1] = 2; stack.push(idx - 1); }
        if (px < width - 1  && st[idx + 1] === 0)     { st[idx + 1] = 2; stack.push(idx + 1); }
        if (py > 0          && st[idx - width] === 0) { st[idx - width] = 2; stack.push(idx - width); }
        if (py < height - 1 && st[idx + width] === 0) { st[idx + width] = 2; stack.push(idx + width); }
      }
      // Enclosed leftovers (st == 0: bright holes ringed by subject) stay transparent.

      // 5) Morphological open on the kept mask to drop thin shadow fringe/speckle.
      let keep = new Uint8Array(N);
      for (let i = 0; i < N; i++) keep[i] = st[i] === 1 ? 1 : 0;

      const morph = (src, erode) => {
        const out = new Uint8Array(N);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = idxAt(x, y);
            let on = 0, off = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= width || yy >= height) { off++; continue; }
                if (src[idxAt(xx, yy)]) on++; else off++;
              }
            }
            out[i] = erode ? (off >= OPEN_OFF ? 0 : src[i])
                           : (on  >= OPEN_ON  ? 1 : src[i]);
          }
        }
        return out;
      };
      keep = morph(keep, true);
      keep = morph(keep, false);

      for (let i = 0, p = 0; i < N; i++, p += 4) {
        if (keep[i]) {
          output[p] = pixels[p]; output[p + 1] = pixels[p + 1];
          output[p + 2] = pixels[p + 2]; output[p + 3] = 255;
        }
      }
      self.postMessage({ pixels: output, width, height });
    };
  `;
  const blob = new Blob([workerCode], { type: "application/javascript" });
  maskWorker = new Worker(URL.createObjectURL(blob));

  maskWorker.onmessage = (e) => {
    const { pixels } = e.data;
    maskUpdateInProgress = false;
    if (!pixels) return;
    previewImage.loadPixels();
    previewImage.pixels.set(pixels);
    previewImage.updatePixels();
  };
  maskWorker.onerror = (e) => { console.error("maskWorker:", e.message); maskUpdateInProgress = false; };
}

function sendToWorker(pixels, hasAlpha) {
  maskUpdateInProgress = true;
  lastSentThreshold = thresholdSlider.value();
  maskWorker.postMessage({
    pixels, width: panelW, height: panelH,
    threshold: thresholdSlider.value(), hasAlpha,
  });
}

function startPreviewUpdateLoop() {
  setTimeout(() => {
    if (!maskUpdateInProgress) {
      if (previewMode === "live" && video && video.loadedmetadata) {
        video.loadPixels();
        if (video.pixels && video.pixels.length === panelW * panelH * 4) {
          const copy = new Uint8ClampedArray(video.pixels.length);
          copy.set(video.pixels);
          sendToWorker(copy, false);
        }
      } else if (previewMode === "static" && staticPixels) {
        if (thresholdSlider.value() !== lastSentThreshold) {
          sendToWorker(staticPixels.slice(), staticHasAlpha);
        }
      }
    }
    startPreviewUpdateLoop();
  }, 100);
}

// ============================ IMAGE INPUT ================================
// Route a pasted / uploaded image into the previewer (static mode).
function loadStaticImage(img) {
  // Detect whether the ORIGINAL image carries transparency.
  img.loadPixels();
  let hasAlpha = false;
  for (let i = 3; i < img.pixels.length; i += 4) {
    if (img.pixels[i] < 250) { hasAlpha = true; break; }
  }

  // Draw it "contained" into a transparent panel-sized buffer.
  const g = createGraphics(panelW, panelH);
  g.pixelDensity(1);
  g.clear();
  const s = Math.min(panelW / img.width, panelH / img.height);
  const w = img.width * s, h = img.height * s;
  g.image(img, (panelW - w) / 2, (panelH - h) / 2, w, h);
  g.loadPixels();

  staticPixels = new Uint8ClampedArray(g.pixels.length);
  staticPixels.set(g.pixels);
  staticHasAlpha = hasAlpha;
  g.remove();

  previewMode = "static";
  lastSentThreshold = -1; // force a re-mask on next loop tick
  previewTransform = { rot: 0, flipH: false, flipV: false };
}

function handlePaste(e) {
  if (appState !== "running") return;
  // If a text field is focused (e.g. the music link box), let it paste text.
  const ae = document.activeElement;
  if (ae && ae.tagName === "INPUT") return;
  const dt = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
  if (!dt) return;
  for (const it of dt.items) {
    if (it.type.indexOf("image") === 0) {
      const blob = it.getAsFile();
      const url = URL.createObjectURL(blob);
      loadImage(url, (img) => { URL.revokeObjectURL(url); loadStaticImage(img); });
      lastPasteMs = millis();
      e.preventDefault();
      return;
    }
  }
}

// Paste button: reads the clipboard directly. Falls back to Ctrl+V if the
// browser/device blocks clipboard access (common on managed school Chrome).
async function pasteFromClipboard() {
  if (appState !== "running") return;
  if (!navigator.clipboard || !navigator.clipboard.read) {
    alert("This device doesn't allow the Paste button — press Ctrl+V instead.");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) {
        const blob = await item.getType(type);
        const url = URL.createObjectURL(blob);
        loadImage(url, (img) => { URL.revokeObjectURL(url); loadStaticImage(img); });
        lastPasteMs = millis();
        return;
      }
    }
    alert("No image on the clipboard. Copy an image first, then try again (or press Ctrl+V).");
  } catch (e) {
    alert("Couldn't read the clipboard (your device may block it). Press Ctrl+V instead.");
  }
}

function handleImageFile(file) {
  if (!file.type.startsWith("image")) { alert("Please choose a PNG or JPEG image."); return; }
  loadImage(file.data, (img) => loadStaticImage(img));
}

// ============================ CAPTURE ====================================
function captureFish() {
  if (appState !== "running" || !previewImage) return;
  let img = cropAndShrink(previewImage);
  if (!img) return; // nothing visible to capture
  img = applyTransform(img, previewTransform);
  addFish(img);
  previewMode = "live"; // return previewer to the webcam
  previewTransform = { rot: 0, flipH: false, flipV: false };
}

// Bake rotate/flip into a fresh image so the swimming fish matches the preview.
function applyTransform(img, t) {
  if (t.rot === 0 && !t.flipH && !t.flipV) return img;
  const rotated = t.rot % 2 === 1;
  const gw = rotated ? img.height : img.width;
  const gh = rotated ? img.width : img.height;
  const g = createGraphics(gw, gh);
  g.pixelDensity(1);
  g.clear();
  g.push();
  g.translate(gw / 2, gh / 2);
  g.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
  g.rotate(t.rot * HALF_PI);
  g.imageMode(CENTER);
  g.image(img, 0, 0, img.width, img.height);
  g.pop();
  const out = g.get();
  g.remove();
  return out;
}

// Crop the masked image to its visible content and downscale it.
function cropAndShrink(src) {
  src.loadPixels();
  const w = src.width, h = src.height;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src.pixels[(y * w + x) * 4 + 3] > 10) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // empty
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const cropped = src.get(minX, minY, cw, ch);
  const scale = Math.min(1, MAX_FISH_IMG_EDGE / Math.max(cw, ch));
  if (scale < 1) cropped.resize(Math.round(cw * scale), Math.round(ch * scale));
  return cropped;
}

function addFish(img) {
  if (!img) return;
  fishArray.push(new Fish(img, aquarium()));
  playSplash();
}

// ============================ DRAW =======================================
function draw() {
  background("#02131c");
  if (appState === "intro") { drawIntro(); return; }

  // Enter idle (pure display) after a quiet spell
  if (!idle && millis() - lastActivityMs > IDLE_MS) setIdle(true);

  if (!idle) drawLeftColumn();
  drawAquarium();
  handleHeldGesture();
}

// Time-based parts of a held gesture: deleting a held fish, and feeding.
function handleHeldGesture() {
  if (!press) return;

  if (press.kind === "fish") {
    if (press.fish && !press.fired && millis() - press.startMs > LONG_PRESS_MS) {
      deleteFish(press.fish);
      press.fired = true;     // consumed; release won't also flip
      press.fish.caught = false;
      press.fish = null;
    }
    return;
  }

  // Water hold -> start feeding once, then trickle while still held & still.
  if (press.kind === "water" && !press.moved) {
    if (!press.fed && millis() - press.startMs > FOOD_HOLD_MS) {
      press.fed = true;
      dropFood(press.x, press.y, FOOD_BURST);
    }
    if (press.fed && frameCount % FOOD_TRICKLE_EVERY === 0) {
      dropFood(press.x, press.y, 1);
    }
  }
}

function drawLeftColumn() {
  push();
  translate(previewMargin, previewMargin);

  // Webcam preview (tap it to return previewer to live)
  if (video) image(video, 0, 0, previewW, previewH);
  else { fill(120); textAlign(CENTER, CENTER); text("Waiting for webcam…", previewW / 2, previewH / 2); }
  noFill(); stroke(previewMode === "live" ? "#4fd6ff" : "rgba(140,210,245,0.3)");
  strokeWeight(2); rect(0, 0, previewW, previewH, 6); noStroke();

  // Mask preview (shows the rotate/flip that will be baked into the fish)
  translate(0, previewH + previewMargin);
  stroke(previewMode === "static" ? "#7dffb0" : "rgba(140,210,245,0.3)");
  rect(0, 0, previewW, previewH, 6); noStroke();
  if (previewImage) {
    const t = previewTransform;
    const rotated = t.rot % 2 === 1;
    const dispW = rotated ? panelH : panelW;
    const dispH = rotated ? panelW : panelH;
    const sf = Math.min(previewW / dispW, previewH / dispH);
    push();
    translate(previewW / 2, previewH / 2);
    scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
    rotate(t.rot * HALF_PI);
    imageMode(CENTER);
    image(previewImage, 0, 0, panelW * sf, panelH * sf);
    pop();
  }
  pop();

  // FPS + instructions (canvas text is allowed; only fish-following text is not)
  noStroke(); fill(180, 220, 245); textAlign(LEFT, TOP); textSize(13);
  let ty = textBlockY;
  text("FPS: " + nf(frameRate(), 2, 0) + "     " + VERSION, previewMargin, ty); ty += 22;
  fill(150, 195, 225); textSize(12);
  const lines = [
    "• Draw a fish, hold it to the webcam,",
    "   then press Capture.",
    "• Or paste (Ctrl/Cmd-V) or Upload an image.",
    "• Tap a fish to turn it around.",
    "• Hold a fish to remove it.",
    "• Hold still on the water to drop food;",
    "   fish grow a little as they eat.",
  ];
  for (const ln of lines) { text(ln, previewMargin, ty); ty += 17; }
}

function aquarium() {
  const x0 = idle ? 0 : previewW + previewMargin * 2;
  return {
    x0,
    w: width - x0 - (idle ? 0 : previewMargin),
    h: height,
    margin: 24,
  };
}

function drawAquarium() {
  const a = aquarium();
  push();
  translate(a.x0, 0);

  if (assetsReady.bg) image(bgImg, 0, 0, a.w, a.h);
  else { fill(8, 40, 60); rect(0, 0, a.w, a.h); }

  // Shark scheduling
  if (!shark && millis() > nextSharkMs) shark = new Shark(a);

  // Ambient rising bubbles spawn from the bottom (fewer now: see BUBBLE_SPAWN_EVERY)
  if (frameCount % BUBBLE_SPAWN_EVERY === 0) {
    bubbles.push(new Bubble(random(0, a.w), a.h + 20, random(14, 38)));
  }
  for (let i = bubbles.length - 1; i >= 0; i--) {
    bubbles[i].update(); bubbles[i].draw();
    if (bubbles[i].offScreen()) bubbles.splice(i, 1);
  }

  // Food flakes (sink, get eaten, or drift off the bottom)
  for (let i = food.length - 1; i >= 0; i--) {
    food[i].update(a);
    food[i].draw();
    if (food[i].eaten || food[i].offScreen(a)) food.splice(i, 1);
  }

  // A nearby shark makes fish calmly seek cover
  if (shark) {
    for (const f of fishArray) {
      if (!f.caught && f.state !== "leaving" && dist(f.x, f.y, shark.x, shark.y) < SHARK_SCARE_RADIUS) f.flee();
    }
  }

  // Rare, random reproduction (not tied to feeding)
  if (millis() > nextReproMs) {
    const eligible = fishArray.filter(canReproduce);
    if (eligible.length) spawnBaby(random(eligible), a);
    nextReproMs = millis() + random(REPRO_MIN_MS, REPRO_MAX_MS);
  }

  // Gentle self-thinning: if crowded, the oldest fish that has had a baby
  // calmly swims off and is retired.
  if (fishArray.length > SOFT_TARGET && !fishArray.some((f) => f.state === "leaving")) {
    const parents = fishArray.filter((f) => f.hasBaby).sort((p, q) => p.id - q.id);
    if (parents.length) parents[0].startLeaving(a);
  }

  // Occasionally let a fish do something special — but only a couple at a time.
  if (frameCount % FLOURISH_CHECK === 0) {
    const active = fishArray.reduce((n, f) => n + (f.flour ? 1 : 0), 0);
    if (active < MAX_FLOURISH && random() < FLOURISH_CHANCE) {
      const pool = fishArray.filter((f) => !f.flour && !f.caught && f.state === "wander" && !(f.parent && f.parentAlive));
      if (pool.length) random(pool).startFlourish();
    }
  }

  // Update everyone, then remove any that have finished leaving
  for (const f of fishArray) f.update(a, food);
  for (let i = fishArray.length - 1; i >= 0; i--) if (fishArray[i].gone) removeFish(fishArray[i]);

  // Draw back-to-front for depth (far fish first)
  const drawList = fishArray.slice().sort((p, q) => q.depth - p.depth);
  for (const f of drawList) f.draw();

  // Shark (drawn over fish, but behind the foreground so it can hide too)
  if (shark) {
    shark.update(a);
    shark.draw();
    if (shark.done) { shark = null; nextSharkMs = millis() + SHARK_INTERVAL_MS; }
  }

  // Foreground rocks & coral — drawn last so fish/shark tuck behind them
  drawForeground();

  // Pop bubbles from deletions (on top of everything)
  for (let i = popBubbles.length - 1; i >= 0; i--) {
    popBubbles[i].update(); popBubbles[i].draw();
    if (popBubbles[i].dead()) popBubbles.splice(i, 1);
  }

  pop();
}

// A fish may have a baby if it's fully grown, hasn't already, the tank isn't
// crowded, and — if it's itself a baby — its own parent has died.
function canReproduce(f) {
  return f.isMature() && !f.hasBaby && f.state !== "leaving" &&
         (!f.isBaby || !f.parentAlive) && fishArray.length < SOFT_TARGET;
}

function spawnBaby(parent, a) {
  parent.hasBaby = true;
  fishArray.push(new Fish(parent.img, a, {
    isBaby: true,
    parent,
    baseLongest: parent.baseLongest,        // grows up to the parent's adult size
    depth: parent.depth,
    x: parent.x - parent.dir * TRAIL_DIST,   // parent.heading never existed -> was NaN
    y: parent.y,
  }));
  playSplash();
}

// Remove a fish and free any baby that was depending on it as a living parent.
function removeFish(f) {
  const idx = fishArray.indexOf(f);
  if (idx === -1) return;
  fishArray.splice(idx, 1);
  for (const other of fishArray) {
    if (other.parent === f) { other.parent = null; other.parentAlive = false; }
  }
}

// ============================ INTRO ======================================
function drawIntro() {
  if (assetsReady.bg) { image(bgImg, 0, 0, width, height); }
  fill(2, 19, 28, 200); rect(0, 0, width, height);

  textAlign(CENTER, CENTER); noStroke();
  fill(180, 235, 255); textSize(min(54, width / 16));
  text("Classroom Aquarium", width / 2, height * 0.3);

  textSize(min(22, width / 40)); fill(200, 230, 250);
  const cy = height * 0.5, gap = min(360, width * 0.26);
  drawHint(width / 2 - gap, cy, "📷", "Scan a drawing");
  drawHint(width / 2,       cy, "📋", "Paste an image");
  drawHint(width / 2 + gap, cy, "🖼", "Upload a file");

  textSize(min(20, width / 44)); fill(150, 215, 255);
  const pulse = 160 + 80 * sin(frameCount * 0.06);
  fill(150, 215, 255, pulse);
  text("Tap anywhere to start", width / 2, height * 0.74);
}

function drawHint(x, y, glyph, label) {
  textSize(min(46, width / 22)); text(glyph, x, y - 8);
  textSize(min(18, width / 50)); fill(190, 225, 248);
  text(label, x, y + 40);
}

// ============================ INPUT ======================================
// Note: these intentionally don't return false. Returning false makes p5
// preventDefault() the pointer event, which blocks the browser from focusing
// text fields (the music link box) and from delivering Ctrl+V paste events.
// Scroll/long-press suppression is handled by CSS + the contextmenu listener.
function mousePressed()  { wake(); pressAt(mouseX, mouseY); }
function mouseReleased() { releasePress(); }
function mouseDragged()  { wake(); moveAt(mouseX, mouseY); }
function mouseMoved()    { wake(); }
function touchStarted()  { wake(); pressAt(mouseX, mouseY); }
function touchEnded()    { releasePress(); }
function touchMoved()    { wake(); moveAt(mouseX, mouseY); }

function pressAt(gx, gy) {
  if (appState === "intro") { startApp(); return; }
  if (idle) return; // a wake tap just brings the UI back; don't also act

  // Tap the webcam preview to cancel a loaded image and go back to live.
  if (gx > previewMargin && gx < previewMargin + previewW &&
      gy > previewMargin && gy < previewMargin + previewH) {
    previewMode = "live";
    previewTransform = { rot: 0, flipH: false, flipV: false };
    return;
  }

  const a = aquarium();
  const lx = gx - a.x0, ly = gy; // aquarium-local coords
  if (lx < 0 || lx > a.w) return; // let DOM controls handle their own clicks

  // Press on a fish -> catch it (release flips, hold deletes).
  for (let i = fishArray.length - 1; i >= 0; i--) {
    if (fishArray[i].hit(lx, ly)) {
      fishArray[i].caught = true;
      press = { kind: "fish", startMs: millis(), x: lx, y: ly,
                moved: false, fired: false, fish: fishArray[i] };
      return;
    }
  }

  // Press on open water -> hold still to drop food. (A tap does nothing.)
  press = { kind: "water", startMs: millis(), x: lx, y: ly,
            moved: false, fed: false, fish: null };
}

function moveAt(gx, gy) {
  if (!press) return;
  if (press.kind === "water" && press.fed) return; // keep feeding through small drift
  const a = aquarium();
  const lx = gx - a.x0, ly = gy;
  if (!press.moved && dist(lx, ly, press.x, press.y) > MOVE_THRESH) press.moved = true;
}

function releasePress() {
  if (!press) return;
  if (press.kind === "fish" && press.fish && !press.fired) {
    press.fish.flip();          // quick release = turn around
    press.fish.caught = false;
  }
  press = null;
}

function dropFood(lx, ly, n) {
  for (let i = 0; i < n && food.length < FOOD_MAX; i++) {
    food.push(new Flake(lx, ly));
  }
}

function deleteFish(f) {
  popPlayAt(f.x, f.y);
  removeFish(f);
}

function popPlayAt(x, y) {
  playPop();
  for (let i = 0; i < 10; i++) popBubbles.push(new PopBubble(x, y));
}

function keyPressed() {
  wake();
  // Ignore keys while typing in a text field (e.g. the music link box).
  const ae = document.activeElement;
  if (ae && ae.tagName === "INPUT") return;
  if (appState !== "running") return;
  if (key === " ") { captureFish(); return; }

  // Ctrl/Cmd + V: if the browser's own paste event doesn't fire (e.g. focus is
  // on a button), fall back to the clipboard API shortly after.
  const cmd = keyIsDown(CONTROL) || keyIsDown(91) || keyIsDown(93);
  if (cmd && (key === "v" || key === "V")) {
    setTimeout(() => { if (millis() - lastPasteMs > 250) pasteFromClipboard(); }, 150);
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (appState === "running") { buildForeground(aquarium()); layoutControls(); }
}

// ============================ FISH =======================================
class Fish {
  constructor(img, a, opts = {}) {
    this.id = ++fishSeq;
    this.img = img;                          // babies share the parent's image
    this.isBaby = !!opts.isBaby;
    this.parent = opts.parent || null;       // the fish this baby trails
    this.parentAlive = !!this.parent;
    this.hasBaby = false;                     // has this fish reproduced yet?

    this.baseLongest = opts.baseLongest != null ? opts.baseLongest
                                               : random(85, 125) * FISH_START_SCALE;
    this.maturity = this.isBaby ? 0 : 1;      // 0 = newborn, 1 = full adult size
    this.fed = 1;                             // feeding multiplier, up to FEED_MAX
    this._setSize();

    this.x = opts.x != null ? opts.x : random(this.w, a.w - this.w);
    this.y = opts.y != null ? opts.y : random(a.margin + this.h, a.h - a.margin - this.h);
    this.dir = random() < 0.5 ? -1 : 1;       // intended horizontal direction (±1)
    this.face = this.dir;                      // continuous facing, eases toward dir (soft turns)
    this.pitch = 0;                            // gentle vertical lean
    this.pitchTarget = 0;
    this.flour = null;                         // current flourish (brief special move)
    this.turnTimer = random(TURN_MIN_FRAMES, TURN_MAX_FRAMES);
    this.baseSpeed = random(0.3, 0.85);       // gentle
    this.speedMult = 1;
    this.nSeed = random(1000);
    this.swayTime = random(TWO_PI);
    this.satiated = 0;
    this.caught = false;
    this.state = "wander";                    // wander | seek | flee | leaving
    this.timer = 0;

    // Depth (parallax). Continuous 0 (front) .. 1 (back), eased toward a target.
    this.depth = opts.depth != null ? opts.depth : floor(random(DEPTH_LAYERS)) / (DEPTH_LAYERS - 1);
    this.depthTarget = this.depth;
    this.depthTimer = random(360, 900);

    this.hideX = 0; this.hideY = 0;
    this.alpha = 0;                           // fade in
    this.alphaTarget = 1;
    this.gone = false;
  }

  _setSize() {
    const matScale = lerp(BABY_START, 1, this.maturity);
    const longest = this.baseLongest * matScale * this.fed;
    if (this.img.width >= this.img.height) {
      this.w = longest; this.h = longest * (this.img.height / this.img.width);
    } else {
      this.h = longest; this.w = longest * (this.img.width / this.img.height);
    }
  }

  isMature() { return this.maturity >= 1; }

  eat() {
    this.fed = Math.min(this.fed * GROW_PER_FEED, FEED_MAX);
    this.satiated = random(SATIATED_FRAMES * 0.8, SATIATED_FRAMES * 1.4);
    // A baby that manages its first feed strikes out on its own, and from then
    // on swims, seeks, flourishes and (once grown) reproduces like any adult.
    if (this.parent && this.parentAlive) {
      this.parent = null;
      this.parentAlive = false;
    }
  }

  flip() { this.dir *= -1; }   // face eases across -> soft turn

  // Steer toward a point: choose a horizontal direction (with a deadzone so it
  // doesn't flicker) and a clamped vertical lean.
  _steerTo(tx, ty, clampP) {
    const dx = tx - this.x, dy = ty - this.y;
    if (dx > 30) this.dir = 1; else if (dx < -30) this.dir = -1;
    this.pitchTarget = constrain(Math.atan2(dy, Math.max(40, Math.abs(dx))), -clampP, clampP);
  }

  flee() {
    if (this.state !== "flee") {
      if (shelters.length) {
        let best = Infinity, sh = shelters[0];
        for (const s of shelters) { const d = Math.abs(s.hideX - this.x); if (d < best) { best = d; sh = s; } }
        this.hideX = sh.hideX; this.hideY = sh.hideY;
      } else { this.hideX = this.x; this.hideY = this.y; }
    }
    this.state = "flee";
    this.timer = 90;
  }

  startLeaving(a) {
    this.state = "leaving";
    this.dir = this.x < a.w / 2 ? -1 : 1; // head for the nearer side
    this.alphaTarget = 0;
  }

  // Begin a brief, calming special move.
  startFlourish() {
    const type = random(["rise", "dive", "loop", "about", "hover"]);
    if (type === "loop") {
      const spin = random() < 0.5 ? 1 : -1;
      const r = random(45, 80);
      const angle0 = random(TWO_PI);
      this.flour = {
        type, spin, r, angle: angle0, timer: Math.round(TWO_PI / LOOP_SPEED) + 10,
        cx: this.x - Math.cos(angle0) * r, cy: this.y - Math.sin(angle0) * r,
      };
    } else if (type === "about") {
      this.flour = { type, timer: 130, startDir: this.dir };
    } else {
      this.flour = { type, timer: random(FLOURISH_MIN, FLOURISH_MAX) };
    }
  }

  _runFlourish() {
    const f = this.flour;
    f.timer--;
    f.speed = this.baseSpeed;
    if (f.type === "rise") { this.pitchTarget = -LEAN_STRONG; f.speed = this.baseSpeed * 0.95; }
    else if (f.type === "dive") { this.pitchTarget = LEAN_STRONG; f.speed = this.baseSpeed * 0.95; }
    else if (f.type === "hover") { this.pitchTarget = 0; f.speed = this.baseSpeed * 0.06; }
    else if (f.type === "about") { this.dir = -f.startDir; if (Math.abs(this.face - this.dir) < 0.1) f.timer = Math.min(f.timer, 1); }
    else if (f.type === "loop") {
      f.angle += f.spin * LOOP_SPEED;
      this._steerTo(f.cx + Math.cos(f.angle) * f.r, f.cy + Math.sin(f.angle) * f.r, 0.6);
      f.speed = this.baseSpeed * 1.15;
    }
    if (f.timer <= 0) this.flour = null;
  }

  update(a, food) {
    this.swayTime += 0.04;
    if (this.maturity < 1) this.maturity = Math.min(1, this.maturity + 1 / MATURE_FRAMES);
    this._setSize();
    this.alpha += (this.alphaTarget - this.alpha) * 0.03;
    if (this.satiated > 0) this.satiated--;
    if (this.caught) return; // frozen while held

    let targetSpeed = this.baseSpeed;
    let depthEase = 0.015;
    const newLayer = () => floor(random(DEPTH_LAYERS)) / (DEPTH_LAYERS - 1);

    // Nearest flake within range (ignored just after a bite). Computed for ALL
    // fish up front so even a parent-following baby can break off to feed.
    let target = null;
    if (food && this.satiated <= 0) {
      let best = SEEK_RADIUS * SEEK_RADIUS;
      for (const fl of food) {
        if (fl.eaten) continue;
        const dx = fl.x - this.x, dy = fl.y - this.y, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; target = fl; }
      }
    }

    if (this.state === "leaving") {
      targetSpeed = this.baseSpeed * 1.5;
      this.pitchTarget = 0;
      if (this.alpha < 0.04 || this.x < -120 || this.x > a.w + 120) this.gone = true;

    } else if (this.state === "flee") {
      this.flour = null;
      if (--this.timer <= 0) this.state = "wander";
      this._steerTo(this.hideX, this.hideY, PITCH_SEEK);
      targetSpeed = Math.hypot(this.hideX - this.x, this.hideY - this.y) > 60 ? this.baseSpeed * 1.8 : this.baseSpeed * 0.2;

    } else if (target) {
      // Food is up for grabs: come to the front layer (food is only eaten
      // there). Checked before parent-following so a baby breaks off to feed.
      this.flour = null; this.state = "seek";
      this.depthTarget = 0; depthEase = SEEK_DEPTH_EASE;
      this._steerTo(target.x, target.y, PITCH_SEEK);
      targetSpeed = this.baseSpeed * 1.5;
      const dx = target.x - this.x, dy = target.y - this.y;
      if (this.depth < FRONT_EAT_DEPTH && Math.abs(dx) < this.w * 0.5 && Math.abs(dy) < this.h * 0.6 && !target.eaten) {
        target.eaten = true; this.eat();
      }

    } else if (this.parent && this.parentAlive) {
      this.flour = null; this.state = "wander";
      const p = this.parent;
      this.depthTarget = p.depth; // swim together
      const tx = p.x - p.dir * TRAIL_DIST, ty = p.y;
      const dd = Math.hypot(tx - this.x, ty - this.y);
      this._steerTo(tx, ty, PITCH_SEEK);
      targetSpeed = constrain(map(dd, 0, 140, this.baseSpeed * 0.2, this.baseSpeed * 1.7), 0, this.baseSpeed * 1.7);

    } else if (this.flour) {
      this.state = "wander";
      this._runFlourish();
      if (this.flour) targetSpeed = this.flour.speed;
      if (--this.depthTimer <= 0) { this.depthTarget = newLayer(); this.depthTimer = random(360, 900); }

    } else {
      this.state = "wander";
      // Mostly drift; occasionally (and softly) turn around.
      if (--this.turnTimer <= 0) {
        this.turnTimer = random(TURN_MIN_FRAMES, TURN_MAX_FRAMES);
        if (random() < TURN_CHANCE) this.dir *= -1;
      }
      this.pitchTarget = (noise(this.nSeed, frameCount * 0.004) - 0.5) * 2 * LEAN_WANDER;
      if (--this.depthTimer <= 0) { this.depthTarget = newLayer(); this.depthTimer = random(360, 900); }
    }

    // Edges: begin a soft turn well before the side walls; lean back from top/bottom.
    if (this.state !== "leaving") {
      if (this.x < SIDE_MARGIN && this.dir < 0) this.dir = 1;
      else if (this.x > a.w - SIDE_MARGIN && this.dir > 0) this.dir = -1;
      const topM = a.margin + this.h, botM = a.h - a.margin - this.h;
      if (this.y < topM) this.pitchTarget = Math.max(this.pitchTarget, LEAN_EDGE);
      else if (this.y > botM) this.pitchTarget = Math.min(this.pitchTarget, -LEAN_EDGE);
    }

    // Ease facing (soft turn), lean, and depth
    this.face += (this.dir - this.face) * TURN_EASE;
    this.pitch += (this.pitchTarget - this.pitch) * 0.04;
    this.depth += (this.depthTarget - this.depth) * depthEase;

    // Integrate (mostly horizontal; the |face| term slows + reverses through a turn)
    const depthSpeed = lerp(1, 0.6, this.depth);
    this.speedMult += (targetSpeed - this.speedMult) * 0.05;
    const v = this.speedMult * depthSpeed;
    this.x += this.face * v * Math.cos(this.pitch);
    this.y += v * Math.sin(this.pitch);

    // Hardening: a stray NaN (e.g. from a bad spawn) must not strand a fish forever.
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) {
      this.x = a.w / 2; this.y = a.h / 2;
      this.pitch = 0; this.speedMult = this.baseSpeed;
      if (!Number.isFinite(this.depth)) this.depth = 0.5;
    }
    this.x = constrain(this.x, -150, a.w + 150);
    if (this.state !== "leaving") this.y = constrain(this.y, this.h / 2, a.h - this.h / 2);
  }

  draw() {
    const ds = lerp(1, DEPTH_BACK_SCALE, this.depth);
    const w = this.w * ds, h = this.h * ds;
    const sway = Math.sin(this.swayTime) * 3 * ds;
    const r = lerp(255, DEPTH_TINT_R, this.depth);
    const g = lerp(255, DEPTH_TINT_G, this.depth);
    const b = lerp(255, DEPTH_TINT_B, this.depth);
    const a = 255 * constrain(this.alpha, 0, 1); // opacity no longer fades with depth

    const fdir = this.face >= 0 ? 1 : -1;
    const heading = Math.atan2(Math.sin(this.pitch), fdir * Math.cos(this.pitch));

    push();
    tint(r, g, b, a);
    translate(this.x, this.y + sway);
    scale(-this.face, 1);                 // continuous mirror; squishes to a sliver mid-turn
    rotate(fdir >= 0 ? -heading : heading + PI);
    imageMode(CENTER);
    image(this.img, 0, 0, w, h);
    pop();
  }

  hit(lx, ly) {
    if (!this.img) return false;
    const ds = lerp(1, DEPTH_BACK_SCALE, this.depth);
    const w = this.w * ds, h = this.h * ds;
    if (w <= 0 || h <= 0) return false;
    const sway = Math.sin(this.swayTime) * 3 * ds;

    // Rebuild the exact draw transform (translate -> scale(-face,1) -> rotate)
    // and invert it, so we know which source-image pixel the tap fell on. Only
    // an opaque pixel counts -- a tap in the empty corner of the box misses.
    const fdir = this.face >= 0 ? 1 : -1;
    const heading = Math.atan2(Math.sin(this.pitch), fdir * Math.cos(this.pitch));
    const rot = fdir >= 0 ? -heading : heading + PI;
    const sx = -this.face;                    // draw uses scale(-face, 1)
    if (Math.abs(sx) < 1e-3) return false;    // mid-turn sliver: nothing to grab

    // Undo translate, then scale, then rotate.
    const qx = (lx - this.x) / sx;
    const qy = ly - (this.y + sway);
    const c = Math.cos(rot), s = Math.sin(rot);
    const ix = qx * c + qy * s;               // rotate by -rot
    const iy = -qx * s + qy * c;

    // Centered display space -> source pixel coords.
    const px = (ix / w + 0.5) * this.img.width;
    const py = (iy / h + 0.5) * this.img.height;
    if (px < 0 || py < 0 || px >= this.img.width || py >= this.img.height) return false;

    return this._alphaAt(px | 0, py | 0) >= ALPHA_HIT;
  }

  // Alpha of a source-image pixel. Pixels are loaded once and cached on the
  // image object, so babies/duplicates sharing an image share the cache too.
  _alphaAt(px, py) {
    const img = this.img;
    if (!img._aLoaded) { img.loadPixels(); img._aLoaded = true; }
    const idx = (py * img.width + px) * 4 + 3;
    if (!img.pixels || idx >= img.pixels.length) return 255; // be forgiving if unreadable
    return img.pixels[idx];
  }
}

// ============================ BUBBLES ====================================
// Render the soft bubble gradient ONCE into an offscreen buffer, then just
// stamp it. This turns thousands of translucent fills per frame into cheap blits.
function makeBubbleSprite() {
  const S = 128;
  const g = createGraphics(S, S);
  g.pixelDensity(1);
  g.clear();
  g.noStroke();
  const c = S / 2, radius = S / 2 - 2;
  for (let r = radius; r > 0; r -= 1) {
    g.fill(180, 220, 255, map(r, 0, radius, 0, 80));
    g.ellipse(c, c, r * 2, r * 2);
  }
  for (let r = radius * 0.6; r > 0; r -= 0.6) {
    g.fill(255, 255, 255, map(r, 0, radius * 0.6, 0, 180));
    g.ellipse(c - radius * 0.15, c - radius * 0.15, r * 2, r * 2);
  }
  g.fill(255, 255, 255, 180);
  g.ellipse(c - radius * 0.25, c - radius * 0.25, S * 0.25, S * 0.15);
  return g;
}

function drawBubble(x, y, d, alphaMul = 1) {
  if (!bubbleSprite) return;
  push();
  imageMode(CENTER);
  if (alphaMul < 1) tint(255, 255 * alphaMul);
  image(bubbleSprite, x, y, d, d);
  pop();
}

class Bubble {
  constructor(x, y, d) {
    this.x = x; this.y = y; this.d = d;
    this.baseX = x; this.phase = random(TWO_PI);
    this.speed = random(1, 2) * BUBBLE_SPEED_SCALE;
  }
  update() { this.y -= this.speed; this.phase += 0.1; this.x = this.baseX + Math.sin(this.phase) * 5; }
  draw() { drawBubble(this.x, this.y, this.d); }
  offScreen() { return this.y + this.d / 2 < 0; }
}

// Burst of fading bubbles when a fish is deleted
class PopBubble {
  constructor(x, y) {
    this.x = x + random(-15, 15);
    this.y = y + random(-15, 15);
    this.d = random(8, 22);
    this.vx = random(-0.6, 0.6);
    this.vy = random(-2.2, -0.8);
    this.life = 1;
    this.fade = random(0.012, 0.025);
  }
  update() { this.x += this.vx; this.y += this.vy; this.vy *= 0.99; this.life -= this.fade; }
  draw() { if (this.life > 0) drawBubble(this.x, this.y, this.d, this.life); }
  dead() { return this.life <= 0; }
}

// Sinking food flake. Fish steer toward it and eat it on contact.
class Flake {
  constructor(x, y) {
    this.x = x + random(-8, 8);
    this.y = y + random(-4, 4);
    this.vx = random(-0.25, 0.25);
    this.vy = random(0.3, 0.7);
    this.size = random(3, 5.5);
    this.phase = random(TWO_PI);
    this.eaten = false;
  }
  update(a) {
    this.phase += 0.08;
    this.x += this.vx + Math.sin(this.phase) * 0.2; // gentle drift
    this.y += this.vy;
    if (this.vy < 0.8) this.vy += 0.005;             // settle to a slow sink
  }
  draw() {
    noStroke();
    fill(255, 206, 130);
    ellipse(this.x, this.y, this.size);
    fill(255, 230, 180, 120);
    ellipse(this.x - this.size * 0.15, this.y - this.size * 0.15, this.size * 0.5);
  }
  offScreen(a) { return this.y > a.h + 12; }
}

// ============================ SHARK ======================================
// Black silhouette that crosses the tank. It only scares; it never eats fish.
class Shark {
  constructor(a) {
    this.len = 230 * SHARK_SCALE;
    this.fromLeft = random() < 0.5;
    this.dir = this.fromLeft ? 1 : -1;
    this.x = this.fromLeft ? -this.len : a.w + this.len;
    this.y = random(a.h * 0.2, a.h * 0.55);
    this.speed = SHARK_SPEED;
    this.sway = random(TWO_PI);
    this.done = false;
  }
  update(a) {
    this.x += this.dir * this.speed;
    this.sway += 0.04;
    this.y += Math.sin(this.sway) * 0.4;
    if (this.fromLeft && this.x > a.w + this.len) this.done = true;
    if (!this.fromLeft && this.x < -this.len) this.done = true;
  }
  draw() {
    push();
    translate(this.x, this.y);
    if (this.dir < 0) scale(-1, 1);      // art faces right
    scale(SHARK_SCALE);                  // overall size
    const tailKick = Math.sin(this.sway * 3) * 8;
    noStroke();
    fill(6, 12, 16, 235);
    // Body
    beginShape();
    vertex(118, 0);
    bezierVertex(85, -26, 15, -30, -55, -16);
    vertex(-118, -6 + tailKick);          // upper tail base
    vertex(-150, -36 + tailKick);         // upper tail tip
    vertex(-112, 0);                      // tail notch
    vertex(-150, 30 + tailKick);          // lower tail tip
    vertex(-118, 8 + tailKick);           // lower tail base
    bezierVertex(15, 26, 85, 26, 118, 0);
    endShape(CLOSE);
    // Dorsal fin
    triangle(8, -26, 42, -68, 56, -22);
    // Pectoral fin
    triangle(24, 16, 58, 54, 70, 18);
    pop();
  }
}

// ============================ FOREGROUND =================================
// Procedural rocks & coral, unique each load. To switch to image files later,
// replace buildForeground/drawForeground with loads/draws of foreground_1..3.png.
function buildForeground(a) {
  shelters = [];
  const n = floor(random(3, 5)); // 3-4 clusters
  for (let i = 0; i < n; i++) {
    const x = map(i + 0.5, 0, n, 0, a.w) + random(-a.w * 0.06, a.w * 0.06);
    shelters.push(random() < 0.55 ? makeRock(x, a) : makeCoral(x, a));
  }
}

function makeRock(x, a) {
  const blobs = [];
  const count = floor(random(4, 7));
  const baseW = random(120, 200) * FOREGROUND_SCALE;
  const baseH = random(80, 150) * FOREGROUND_SCALE;
  for (let i = 0; i < count; i++) {
    const tone = random(38, 64);
    blobs.push({
      dx: random(-baseW * 0.4, baseW * 0.4),
      dy: random(-baseH * 0.5, 0),
      w: random(baseW * 0.4, baseW * 0.75),
      h: random(baseH * 0.4, baseH * 0.8),
      col: [tone + random(-8, 8), tone + random(-4, 10), tone + random(0, 14)],
    });
  }
  return { type: "rock", x, baseY: a.h + 8, blobs,
           hideX: x, hideY: a.h - baseH * 0.45 };
}

function makeCoral(x, a) {
  const palette = [[170, 92, 120], [196, 120, 70], [90, 150, 150], [150, 110, 175]];
  const base = random(palette);
  const branches = [];
  const count = floor(random(3, 6));
  const height = random(110, 190) * FOREGROUND_SCALE;
  for (let i = 0; i < count; i++) {
    branches.push({
      x: random(-50, 50) * FOREGROUND_SCALE,
      len: random(height * 0.5, height),
      lean: random(-0.5, 0.5),
      thick: random(8, 16) * FOREGROUND_SCALE,
      col: [base[0] + random(-25, 25), base[1] + random(-25, 25), base[2] + random(-25, 25)],
    });
  }
  return { type: "coral", x, baseY: a.h + 8, branches,
           hideX: x, hideY: a.h - height * 0.4 };
}

function drawForeground() {
  noStroke();
  for (const s of shelters) {
    push();
    translate(s.x, s.baseY);
    if (s.type === "rock") {
      for (const b of s.blobs) {
        fill(b.col[0], b.col[1], b.col[2]);
        ellipse(b.dx, b.dy, b.w, b.h);
      }
    } else {
      for (const br of s.branches) {
        fill(br.col[0], br.col[1], br.col[2]);
        push();
        translate(br.x, 0);
        // a tapering branch made of stacked rounded segments
        const segs = 8;
        for (let i = 0; i < segs; i++) {
          const t = i / segs;
          const yy = -br.len * t;
          const xx = br.lean * br.len * t * t;
          const w = br.thick * (1 - t * 0.7);
          ellipse(xx, yy, w, w * 1.4);
        }
        // little tip nubs
        const tx = br.lean * br.len, ty = -br.len;
        ellipse(tx - 6, ty + 6, br.thick * 0.5, br.thick * 0.5);
        ellipse(tx + 6, ty + 4, br.thick * 0.5, br.thick * 0.5);
        pop();
      }
    }
    pop();
  }
}

// ============================ SOUND ======================================
function playSplash() {
  const ready = splashSounds.filter((s, i) => assetsReady.splash[i] && s);
  if (muted || ready.length === 0) return;
  const s = random(ready);
  s.setVolume(0.6);
  s.play();
}

// Synthesised "pop" (no audio file needed)
function playPop() {
  if (muted) return;
  try {
    const osc = new p5.Oscillator("sine");
    const env = new p5.Envelope();
    env.setADSR(0.001, 0.09, 0, 0.08);
    env.setRange(0.4, 0);
    osc.start();
    osc.freq(620);
    osc.freq(180, 0.12);
    env.play(osc);
    setTimeout(() => osc.stop(), 220);
  } catch (e) { /* audio context not ready */ }
}

// ============================ BACKUP / RESTORE ===========================
function loadScriptAsync(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.onload = resolve; s.onerror = reject; s.src = src;
    document.head.appendChild(s);
  });
}
async function loadLibraries() {
  await loadScriptAsync("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  await loadScriptAsync("https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js");
}

async function backupFish() {
  if (fishArray.length === 0) { alert("The tank is empty — nothing to back up yet."); return; }
  const zip = new JSZip();
  fishArray.forEach((f, i) => {
    const dataURL = f.img.canvas.toDataURL("image/png");
    zip.file(`fish_${i}.png`, dataURLToBlob(dataURL));
  });
  const blob = await zip.generateAsync({ type: "blob" });
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  saveAs(blob, `aquarium_backup_${ts}.zip`);
}

function dataURLToBlob(dataurl) {
  const arr = dataurl.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8 = new Uint8Array(n);
  while (n--) u8[n] = bstr.charCodeAt(n);
  return new Blob([u8], { type: mime });
}

async function handleZipFile(file) {
  if (!file.name.toLowerCase().endsWith(".zip")) { alert("Please choose a ZIP backup."); return; }
  try {
    const zip = await JSZip.loadAsync(file.file);
    const pngs = Object.values(zip.files).filter((f) => !f.dir && /\.png$/i.test(f.name));
    if (pngs.length === 0) { alert("No fish images found in that ZIP."); return; }
    const imgs = await Promise.all(pngs.map(async (f) => {
      const buf = await f.async("arraybuffer");
      const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
      return new Promise((res) => loadImage(url, (img) => { URL.revokeObjectURL(url); res(img); }));
    }));
    for (const img of imgs) addFish(img);
  } catch (err) {
    alert("Could not read that ZIP: " + err.message);
  }
}
