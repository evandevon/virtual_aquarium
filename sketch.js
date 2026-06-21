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
const MAX_FISH_IMG_EDGE = 200; // stored image longest edge, px

// ---- Interaction ----
const LONG_PRESS_MS = 550;     // hold this long to delete a caught fish
const HIT_INFLATE = 1.25;      // forgiving touch box

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

// Press / catch state
let heldFish = null;
let pressStartMs = 0;
let longPressFired = false;

// DOM controls (so we can show/hide and re-layout)
let controls = [];
let captureBtn, uploadImgBtn, backupBtn, restoreBtn, muteBtn;
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
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  frameRate(60);
  imageMode(CORNER);

  previewImage = createImage(panelW, panelH);
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

  // Hidden native file inputs
  imgFileInput = createFileInput(handleImageFile);
  imgFileInput.attribute("accept", "image/png,image/jpeg");
  imgFileInput.style("display", "none");

  zipFileInput = createFileInput(handleZipFile);
  zipFileInput.attribute("accept", ".zip");
  zipFileInput.style("display", "none");

  controls = [thresholdSlider, videoSelect, captureBtn, uploadImgBtn,
              backupBtn, restoreBtn, muteBtn];
}

function layoutControls() {
  const x = previewMargin;
  let y = previewMargin + previewH;            // below webcam preview
  y += previewMargin + previewH + previewMargin; // below mask preview

  videoSelect.position(x, y); videoSelect.size(previewW); y += 38;
  thresholdSlider.position(x, y); thresholdSlider.style("width", previewW + "px"); y += 38;

  const full = (b, h) => { b.position(x, y); b.size(previewW, h); y += h + 8; };
  full(captureBtn, 50);
  full(uploadImgBtn, 42);
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

function handleImageFile(file) {
  if (!file.type.startsWith("image")) { alert("Please choose a PNG or JPEG image."); return; }
  loadImage(file.data, (img) => loadStaticImage(img));
}

// ============================ CAPTURE ====================================
function captureFish() {
  if (appState !== "running" || !previewImage) return;
  const img = cropAndShrink(previewImage);
  if (!img) return; // nothing visible to capture
  addFish(img);
  previewMode = "live"; // return previewer to the webcam
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

  // Long-press deletion check (independent of release event)
  if (heldFish && !longPressFired && millis() - pressStartMs > LONG_PRESS_MS) {
    deleteFish(heldFish);
    longPressFired = true;
    heldFish = null;
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

  // Mask preview
  translate(0, previewH + previewMargin);
  stroke(previewMode === "static" ? "#7dffb0" : "rgba(140,210,245,0.3)");
  rect(0, 0, previewW, previewH, 6); noStroke();
  if (previewImage) {
    const sf = Math.min(previewW / panelW, previewH / panelH);
    const iw = panelW * sf, ih = panelH * sf;
    image(previewImage, (previewW - iw) / 2, (previewH - ih) / 2, iw, ih);
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
    "• Or paste an image (Ctrl/Cmd-V).",
    "• Or Upload Image to clean its background.",
    "• Tap a fish to turn it around.",
    "• Hold a fish to remove it.",
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

  // Ambient rising bubbles spawn from the bottom
  if (frameCount % 12 === 0) {
    bubbles.push(new Bubble(random(0, a.w), a.h + 20, random(14, 38)));
  }
  for (let i = bubbles.length - 1; i >= 0; i--) {
    bubbles[i].update(); bubbles[i].draw();
    if (bubbles[i].offScreen()) bubbles.splice(i, 1);
  }

  // Fish
  for (const f of fishArray) { f.update(a); f.draw(); }

  // Pop bubbles from deletions (on top)
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
function touchStarted()  { return pressAt(mouseX, mouseY); }
function touchEnded()    { releasePress(); }

function pressAt(gx, gy) {
  if (appState === "intro") { startApp(); return false; }

  // Tap the webcam preview to cancel a loaded image and go back to live.
  if (gx > previewMargin && gx < previewMargin + previewW &&
      gy > previewMargin && gy < previewMargin + previewH) {
    previewMode = "live";
    return false;
  }

  const a = aquarium();
  const lx = gx - a.x0, ly = gy; // aquarium-local coords
  if (lx < 0 || lx > a.w) return; // let DOM controls handle their own clicks

  for (let i = fishArray.length - 1; i >= 0; i--) {
    if (fishArray[i].hit(lx, ly)) {
      heldFish = fishArray[i];
      heldFish.caught = true;
      pressStartMs = millis();
      longPressFired = false;
      return false;
    }
  }
}

function releasePress() {
  if (heldFish && !longPressFired) {
    heldFish.flip();        // quick release = turn around
    heldFish.caught = false;
  }
  heldFish = null;
  longPressFired = false;
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
}

// ============================ FISH =======================================
class Fish {
  constructor(img, a) {
    const longest = Math.max(img.width, img.height);
    const dispLongest = random(85, 125);
    const s = dispLongest / longest;
    this.img = img;
    this.w = img.width * s;
    this.h = img.height * s;

    this.x = random(this.w, a.w - this.w);
    this.y = random(a.margin + this.h, a.h - a.margin - this.h);
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
  }

  pickState() {
    const r = random();
    if (r < 0.15) { this.state = "dart"; this.speedMultTarget = random(2.6, 4.2); this.timer = random(45, 90); }
    else if (r < 0.35) { this.state = "tilt"; this.tiltDir = random() < 0.5 ? -1 : 1; this.timer = random(50, 100); }
    else { this.state = "cruise"; this.speedMultTarget = 1; this.timer = random(120, 260); }
  }

  flip() { this.dir *= -1; }

  update(a) {
    this.swayTime += 0.05;
    if (this.caught) return; // frozen while held

    if (--this.timer <= 0) this.pickState();
    this.speedMult += (this.speedMultTarget - this.speedMult) * 0.08;
    const vyTarget = this.state === "tilt" ? this.tiltDir * this.baseSpeed * 1.2 : 0;
    this.vy += (vyTarget - this.vy) * 0.05;

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
function drawBubble(x, y, d, alphaMul = 1) {
  push();
  translate(x, y);
  noStroke();
  const radius = d / 2;
  for (let r = radius; r > 0; r -= 1) {
    fill(180, 220, 255, map(r, 0, radius, 0, 80) * alphaMul);
    ellipse(0, 0, r * 2, r * 2);
  }
  for (let r = radius * 0.6; r > 0; r -= 0.6) {
    fill(255, 255, 255, map(r, 0, radius * 0.6, 0, 180) * alphaMul);
    ellipse(-radius * 0.15, -radius * 0.15, r * 2, r * 2);
  }
  fill(255, 255, 255, 180 * alphaMul);
  ellipse(-radius * 0.25, -radius * 0.25, d * 0.25, d * 0.15);
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
