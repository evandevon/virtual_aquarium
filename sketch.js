/* =========================================================================
   CLASSROOM AQUARIUM
   - Draw a fish on paper -> scan with webcam, OR paste an image, OR upload one.
   - Images route through the previewer for background removal, then "Capture".
   - Fish swim, occasionally dart and tilt.
   - Press a fish to catch it; quick release flips it, long press deletes it.
   - Backup / restore the tank as a ZIP.
   ========================================================================= */

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
const HIT_INFLATE = 1.25;      // forgiving touch box

// ---- Water gestures (scare / feed) ----
const MOVE_THRESH = 16;        // px of movement that turns a press into a drag
const FOOD_HOLD_MS = 700;      // stationary hold on water before food drops
const FOOD_BURST = 6;          // flakes dropped the moment feeding starts
const FOOD_TRICKLE_EVERY = 10; // frames between trickle flakes while holding
const FOOD_MAX = 60;           // total flakes alive at once (perf cap)
const SCARE_RADIUS = 130;      // how far a tap/swipe scare reaches
const SCARE_FRAMES = 90;       // ~1.5s flee at 60fps
const SEEK_RADIUS = 150;       // how far a fish notices food

// ---- Growth & cloning ----
const FISH_CAP = 80;           // cloning pauses at this many fish (raise to taste)
const GROWTH_PER_FEED = 1.1;   // x1.1 size each flake eaten
const GROWTH_CAP = 2.5;        // max multiple of starting size
const CLONE_EVERY = 3;         // an original spawns a clone every N feeds
const CLONE_SCALE = 0.4;       // clone starts at 40% of parent's current size

// ---- Shark ----
const SHARK_INTERVAL_MS = 5 * 60 * 1000; // a shark passes ~every 5 minutes
const SHARK_SCARE_RADIUS = 230;          // fish flee/hide within this of the shark

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
let pendingClones = [];        // clone requests collected during a frame
let shark = null;
let nextSharkMs = Infinity;
let shelters = [];             // procedural foreground rocks/coral
let bubbleSprite = null;       // cached soft-bubble image (perf)

// Preview transform applied before capture (rotate-right / flip H / flip V)
let previewTransform = { rot: 0, flipH: false, flipV: false };

// Press state (one gesture at a time). Locked to a target at press time.
// press = { kind:'fish'|'water', startMs, x, y, moved, fed, fish }
let press = null;

// DOM controls (so we can show/hide and re-layout)
let controls = [];
let captureBtn, uploadImgBtn, pasteBtn, backupBtn, restoreBtn, muteBtn;
let rotateBtn, flipHBtn, flipVBtn;     // overlaid on the preview
let imgFileInput, zipFileInput;
let muted = false;

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
}

// ============================ CONTROLS ===================================
function buildControls() {
  thresholdSlider = createSlider(0, 255, 180);

  videoSelect = createSelect();
  videoSelect.changed(() => startVideo(videoSelect.value()));

  captureBtn = createButton("📸  Capture Fish");
  captureBtn.elt.classList.add("primary-btn");
  captureBtn.mousePressed(captureFish);

  uploadImgBtn = createButton("🖼  Upload Image");
  uploadImgBtn.mousePressed(() => imgFileInput.elt.click());

  pasteBtn = createButton("📋  Paste (Ctrl+V)");
  pasteBtn.mousePressed(pasteFromClipboard);

  backupBtn = createButton("💾  Backup Tank");
  backupBtn.mousePressed(() => {
    if (!libsLoaded) loadLibraries().then(() => { libsLoaded = true; backupFish(); });
    else backupFish();
  });

  restoreBtn = createButton("📂  Restore Tank");
  restoreBtn.mousePressed(() => {
    if (!libsLoaded) loadLibraries().then(() => { libsLoaded = true; zipFileInput.elt.click(); });
    else zipFileInput.elt.click();
  });

  muteBtn = createButton("🔊  Sound On");
  muteBtn.mousePressed(toggleMute);

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
              backupBtn, restoreBtn, muteBtn, rotateBtn, flipHBtn, flipVBtn];
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

  videoSelect.position(x, y); videoSelect.size(previewW); y += 38;
  thresholdSlider.position(x, y); thresholdSlider.style("width", previewW + "px"); y += 38;

  const full = (b, h) => { b.position(x, y); b.size(previewW, h); y += h + 8; };
  full(captureBtn, 50);
  full(uploadImgBtn, 42);
  full(pasteBtn, 42);
  full(backupBtn, 42);
  full(restoreBtn, 42);
  full(muteBtn, 42);

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

      // Opaque source (webcam / flat image): brightness-based removal.
      // A pixel is a "background candidate" if it's transparent OR bright.
      const bw = new Uint8Array(width * height);
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        const brightness = (pixels[i] + pixels[i+1] + pixels[i+2]) / 3;
        bw[i >> 2] = (a > 128 && brightness < threshold) ? 1 : 0;
      }

      function floodFill(x, y) {
        const start = y * width + x;
        if (bw[start] !== 0) return;
        const stack = [start];
        while (stack.length) {
          const idx = stack.pop();
          if (idx < 0 || idx >= width * height || bw[idx] !== 0) continue;
          bw[idx] = 2;
          const px = idx % width, py = (idx / width) | 0;
          if (px > 0) stack.push(idx - 1);
          if (px < width - 1) stack.push(idx + 1);
          if (py > 0) stack.push(idx - width);
          if (py < height - 1) stack.push(idx + width);
        }
      }
      for (let x = 0; x < width; x++) { floodFill(x, 0); floodFill(x, height - 1); }
      for (let y = 0; y < height; y++) { floodFill(0, y); floodFill(width - 1, y); }

      for (let i = 0; i < bw.length; i++) {
        const p = i * 4;
        if (bw[i] === 1) { // kept subject
          output[p] = pixels[p]; output[p+1] = pixels[p+1];
          output[p+2] = pixels[p+2]; output[p+3] = 255;
        } // 0 (interior hole reclaimed) and 2 (outside) -> transparent
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
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (const it of items) {
    if (it.type.indexOf("image") === 0) {
      const blob = it.getAsFile();
      const url = URL.createObjectURL(blob);
      loadImage(url, (img) => { URL.revokeObjectURL(url); loadStaticImage(img); });
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

  drawLeftColumn();
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
  text("FPS: " + nf(frameRate(), 2, 0), previewMargin, ty); ty += 22;
  fill(150, 195, 225); textSize(12);
  const lines = [
    "• Draw a fish, hold it to the webcam,",
    "   then press Capture.",
    "• Or paste (Ctrl/Cmd-V) or Upload an image.",
    "• Tap a fish to turn it around.",
    "• Hold a fish to remove it.",
    "• Tap or swipe the water to scare them.",
    "• Hold still on the water to drop food;",
    "   fish grow as they eat (and may clone!).",
  ];
  for (const ln of lines) { text(ln, previewMargin, ty); ty += 17; }
}

function aquarium() {
  const x0 = previewW + previewMargin * 2;
  return {
    x0,
    w: width - x0 - previewMargin,
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

  // Ambient rising bubbles spawn from the bottom
  if (frameCount % 12 === 0) {
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

  // A nearby shark keeps fish fleeing/hiding
  if (shark) {
    for (const f of fishArray) {
      if (!f.caught && dist(f.x, f.y, shark.x, shark.y) < SHARK_SCARE_RADIUS) f.flee(shark.x, shark.y);
    }
  }

  // Fish (clones requested during update are added afterwards)
  pendingClones.length = 0;
  for (const f of fishArray) { f.update(a, food); f.draw(); }
  for (const parent of pendingClones) {
    if (fishArray.length >= FISH_CAP) break;
    fishArray.push(new Fish(parent.img, a, {
      isClone: true,
      baseLongest: parent.baseLongest * parent.growth * CLONE_SCALE,
      x: parent.x + random(-30, 30),
      y: parent.y + random(-20, 20),
    }));
    playSplash();
  }
  pendingClones.length = 0;

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
function mousePressed()  { return pressAt(mouseX, mouseY); }
function mouseReleased() { releasePress(); }
function mouseDragged()  { return moveAt(mouseX, mouseY); }
function touchStarted()  { return pressAt(mouseX, mouseY); }
function touchEnded()    { releasePress(); }
function touchMoved()    { return moveAt(mouseX, mouseY); }

function pressAt(gx, gy) {
  if (appState === "intro") { startApp(); return false; }

  // Tap the webcam preview to cancel a loaded image and go back to live.
  if (gx > previewMargin && gx < previewMargin + previewW &&
      gy > previewMargin && gy < previewMargin + previewH) {
    previewMode = "live";
    previewTransform = { rot: 0, flipH: false, flipV: false };
    return false;
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
      return false;
    }
  }

  // Press on open water -> wait to see: tap/drag = scare, still hold = feed.
  press = { kind: "water", startMs: millis(), x: lx, y: ly,
            moved: false, fed: false, fish: null };
  return false;
}

function moveAt(gx, gy) {
  if (!press) return;
  // Once feeding has begun, small drift shouldn't turn it into a scare.
  if (press.kind === "water" && press.fed) return false;

  const a = aquarium();
  const lx = gx - a.x0, ly = gy;
  if (!press.moved && dist(lx, ly, press.x, press.y) > MOVE_THRESH) press.moved = true;

  if (press.kind === "water" && press.moved) {
    // Swiping across water scares fish along the path.
    scareAt(lx, ly);
  }
  return false; // prevent page scroll on touch
}

function releasePress() {
  if (!press) return;

  if (press.kind === "fish") {
    if (press.fish && !press.fired) {
      press.fish.flip();          // quick release = turn around
      press.fish.caught = false;
    }
  } else if (press.kind === "water") {
    // A still, quick tap (never moved, never fed) is a scare.
    if (!press.moved && !press.fed) scareAt(press.x, press.y);
  }
  press = null;
}

function scareAt(lx, ly) {
  for (const f of fishArray) {
    if (f.caught) continue;
    if (dist(f.x, f.y, lx, ly) < SCARE_RADIUS) f.flee(lx, ly);
  }
}

function dropFood(lx, ly, n) {
  for (let i = 0; i < n && food.length < FOOD_MAX; i++) {
    food.push(new Flake(lx, ly));
  }
}

function deleteFish(f) {
  const idx = fishArray.indexOf(f);
  if (idx === -1) return;
  fishArray.splice(idx, 1);
  playPop();
  for (let i = 0; i < 10; i++) popBubbles.push(new PopBubble(f.x, f.y));
}

function keyPressed() {
  if (appState === "running" && key === " ") captureFish();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (appState === "running") buildForeground(aquarium());
}

// ============================ FISH =======================================
class Fish {
  constructor(img, a, opts = {}) {
    this.img = img;                       // clones share their parent's image
    this.isClone = !!opts.isClone;
    this.baseLongest = opts.baseLongest || random(85, 125);
    this.growth = 1;
    this.feeds = 0;
    this._setSize();

    this.x = opts.x != null ? opts.x : random(this.w, a.w - this.w);
    this.y = opts.y != null ? opts.y : random(a.margin + this.h, a.h - a.margin - this.h);
    this.dir = random() < 0.5 ? -1 : 1;
    this.baseSpeed = random(0.35, 1.1);
    this.speedMult = 1;
    this.speedMultTarget = 1;
    this.vy = 0;
    this.tiltDir = 1;
    this.swayTime = random(TWO_PI);
    this.state = "cruise";
    this.timer = random(90, 220);
    this.caught = false;
    this.fleeVy = 0;
    this.seekVy = 0;
    this.hideX = 0;
    this.hideY = 0;
  }

  _setSize() {
    const longest = this.baseLongest * this.growth;
    if (this.img.width >= this.img.height) {
      this.w = longest; this.h = longest * (this.img.height / this.img.width);
    } else {
      this.h = longest; this.w = longest * (this.img.width / this.img.height);
    }
  }

  // Eat a flake: grow, and (originals only) clone every few feeds.
  eat() {
    this.feeds++;
    this.growth = Math.min(this.growth * GROWTH_PER_FEED, GROWTH_CAP);
    this._setSize();
    if (!this.isClone && this.feeds % CLONE_EVERY === 0 && fishArray.length < FISH_CAP) {
      pendingClones.push(this);
    }
  }

  pickState() {
    const r = random();
    if (r < 0.15) { this.state = "dart"; this.speedMultTarget = random(2.6, 4.2); this.timer = random(45, 90); }
    else if (r < 0.35) { this.state = "tilt"; this.tiltDir = random() < 0.5 ? -1 : 1; this.timer = random(50, 100); }
    else { this.state = "cruise"; this.speedMultTarget = 1; this.timer = random(120, 260); }
  }

  flip() { this.dir *= -1; }

  // Scared: bolt for the nearest shelter (or just away if there are none).
  flee(fx, fy) {
    if (this.state !== "flee") {
      if (shelters.length) {
        let best = Infinity, sh = shelters[0];
        for (const s of shelters) {
          const d = Math.abs(s.hideX - this.x);
          if (d < best) { best = d; sh = s; }
        }
        this.hideX = sh.hideX; this.hideY = sh.hideY;
      } else {
        this.hideX = this.x + (this.x - fx >= 0 ? 1 : -1) * 280;
        this.hideY = this.y;
      }
    }
    this.state = "flee";
    this.timer = SCARE_FRAMES;
  }

  update(a, food) {
    this.swayTime += 0.05;
    if (this.caught) return; // frozen while held

    let vyTarget = 0;

    if (this.state === "flee") {
      // Hiding overrides food. Dash to the shelter, then tuck in.
      if (--this.timer <= 0) { this.state = "cruise"; this.speedMultTarget = 1; this.timer = random(60, 160); }
      const dx = this.hideX - this.x, dy = this.hideY - this.y;
      const distToHide = Math.hypot(dx, dy);
      this.dir = dx >= 0 ? 1 : -1;
      this.speedMultTarget = distToHide > 50 ? 4 : 0.15;
      this.speedMult += (this.speedMultTarget - this.speedMult) * 0.12;
      vyTarget = constrain(dy * 0.06, -this.baseSpeed * 3, this.baseSpeed * 3);
    } else {
      // Look for the nearest flake within range.
      let target = null, best = SEEK_RADIUS * SEEK_RADIUS;
      if (food) {
        for (const fl of food) {
          if (fl.eaten) continue;
          const dx = fl.x - this.x, dy = fl.y - this.y, d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; target = fl; }
        }
      }

      if (target) {
        // Steer toward the food and eat it on contact.
        const dx = target.x - this.x, dy = target.y - this.y;
        this.dir = dx >= 0 ? 1 : -1;
        this.state = "seek";
        this.speedMult += (2.2 - this.speedMult) * 0.1;
        vyTarget = constrain(dy * 0.06, -this.baseSpeed * 2.2, this.baseSpeed * 2.2);
        this.seekVy = vyTarget;
        if (Math.abs(dx) < this.w * 0.45 && Math.abs(dy) < this.h * 0.55 && !target.eaten) {
          target.eaten = true;
          this.eat();
        }
      } else {
        if (this.state === "seek") { this.state = "cruise"; this.speedMultTarget = 1; this.timer = random(60, 160); }
        if (--this.timer <= 0) this.pickState();
        this.speedMult += (this.speedMultTarget - this.speedMult) * 0.08;
        if (this.state === "tilt") vyTarget = this.tiltDir * this.baseSpeed * 1.2;
      }
    }

    this.vy += (vyTarget - this.vy) * 0.08;

    const vx = this.dir * this.baseSpeed * this.speedMult;
    this.x += vx;
    this.y += this.vy;

    // Horizontal walls -> turn around
    if (this.x < this.w / 2) { this.x = this.w / 2; this.dir = 1; }
    else if (this.x > a.w - this.w / 2) { this.x = a.w - this.w / 2; this.dir = -1; }

    // Vertical walls -> nudge back in
    const top = a.margin + this.h / 2, bot = a.h - a.margin - this.h / 2;
    if (this.y < top) { this.y = top; this.vy = Math.abs(this.vy); this.tiltDir = 1; }
    else if (this.y > bot) { this.y = bot; this.vy = -Math.abs(this.vy); this.tiltDir = -1; }
  }

  draw() {
    const vx = this.dir * this.baseSpeed * this.speedMult;
    const heading = Math.atan2(this.vy, vx);
    const sway = Math.sin(this.swayTime) * 3;

    push();
    translate(this.x, this.y + sway);
    // Sprite art faces LEFT by default.
    if (this.dir >= 0) { scale(-1, 1); rotate(-heading); }
    else { rotate(heading + PI); }
    imageMode(CENTER);
    image(this.img, 0, 0, this.w, this.h);
    pop();
  }

  hit(lx, ly) {
    const hw = (this.w / 2) * HIT_INFLATE;
    const hh = (this.h / 2) * HIT_INFLATE;
    const sway = Math.sin(this.swayTime) * 3;
    return lx > this.x - hw && lx < this.x + hw &&
           ly > this.y + sway - hh && ly < this.y + sway + hh;
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
    this.baseX = x; this.phase = random(TWO_PI); this.speed = random(1, 2);
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
    this.len = 230;
    this.fromLeft = random() < 0.5;
    this.dir = this.fromLeft ? 1 : -1;
    this.x = this.fromLeft ? -this.len : a.w + this.len;
    this.y = random(a.h * 0.2, a.h * 0.55);
    this.speed = 2.3;
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
  const baseW = random(120, 200);
  const baseH = random(80, 150);
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
  const height = random(110, 190);
  for (let i = 0; i < count; i++) {
    branches.push({
      x: random(-50, 50),
      len: random(height * 0.5, height),
      lean: random(-0.5, 0.5),
      thick: random(8, 16),
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
