# Classroom Aquarium

A relaxing interactive display. Kids draw fish on paper and scan them with a
webcam, paste an image, or upload a file — each creature swims around its own
little reef. Built with [p5.js](https://p5js.org/).

## Folder layout

```
aquarium/
├── index.html
├── sketch.js
├── README.md
└── assets/
    ├── reef.jpg          ← background image
    ├── ambience.mp3      ← looping underwater ambience
    ├── splash_1.mp3      ← played randomly when a fish is added
    ├── splash_2.mp3
    └── splash_3.mp3
```

Put your five media files in `assets/` with exactly those names. (The delete
"pop" is synthesised in code — no file needed.) Missing files don't crash the
app: the background falls back to a plain colour and sounds simply stay silent.

## Publishing to GitHub Pages

1. Create a new repository and upload the whole `aquarium/` contents to its
   root (so `index.html` is at the top level).
2. Repo **Settings → Pages → Build and deployment**: set **Source = Deploy from
   a branch**, branch `main`, folder `/ (root)`. Save.
3. Wait ~1 minute; your site appears at
   `https://<your-username>.github.io/<repo-name>/`.

Pages serves over HTTPS, which the webcam requires — so it works out of the box.

### School networks that block external domains

`index.html` loads p5 from a CDN by default so it runs immediately. If your IT
setup blocks outside domains (the thing that's been blocking your audio), make
the page fully self-contained:

1. Download these two files into the `aquarium/` folder:
   - https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.4/p5.min.js
   - https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.4/addons/p5.sound.min.js
2. In `index.html`, replace the two CDN `<script>` tags with:
   ```html
   <script src="p5.min.js"></script>
   <script src="p5.sound.min.js"></script>
   ```

That removes every external dependency **except** Backup/Restore, which pull
JSZip + FileSaver from a CDN on first use. If you need those offline too,
download `jszip.min.js` and `FileSaver.min.js` locally and adjust
`loadLibraries()` in `sketch.js`.

## Using it

- **Tap anywhere** on the intro screen to start (this unlocks audio and the
  webcam — required by browsers).
- **Scan:** hold a drawing up to the webcam, adjust the threshold slider if
  needed, press **Capture Fish** (or the spacebar).
- **Paste:** copy an image and press **Ctrl/Cmd-V**, or use the **Paste**
  button (the button needs clipboard permission — if your device blocks it,
  it'll tell you to use Ctrl+V).
- **Upload:** **Upload Image** loads a PNG/JPEG into the previewer.
- **Rotate / flip:** the ↻ ⇄ ⇅ buttons on the mask preview rotate-right and
  flip the image before you capture it.
- Tap the **webcam preview** any time to switch the previewer back to live.
- **Tap a fish** to turn it around; **press and hold** a fish to remove it.
- **Tap or swipe** open water to scare the fish; **hold still** on the water to
  drop food. Fish that eat **grow**, and every few feeds an original spawns a
  small **clone** of itself (cloning pauses at the fish cap).
- A **shark** silhouette passes through roughly every 5 minutes; the fish flee
  and hide behind the rocks and coral. The shark never eats them.
- **Backup/Restore Tank** saves or reloads all current fish as a ZIP.

## Tuning

All the dials are constants near the top of `sketch.js`: `FISH_CAP` (raise for a
bigger tank), `GROWTH_CAP`, `CLONE_EVERY`, `SHARK_INTERVAL_MS`, `SCARE_RADIUS`,
`SEEK_RADIUS`, `FOOD_HOLD_MS`, and `MAX_FISH_IMG_EDGE` (fish image resolution).

## Swapping the rocks & coral for your own art

The foreground is generated procedurally (unique each load). To use your own
pictures instead, drop `foreground_1.png`, `foreground_2.png`,
`foreground_3.png` (transparent PNGs) in `assets/`, preload them, and replace
the bodies of `buildForeground()` / `drawForeground()` in `sketch.js` to pick
one at random and draw it across the bottom. The fish hide logic keys off each
shelter's `hideX`/`hideY`, so set those per image and the behaviour still works.

### Background removal notes

- A clean image *with transparency* (e.g. a cut-out PNG) is respected as-is.
- A *flat* image (webcam frame, JPEG, shape on white) uses brightness removal:
  it keeps dark drawing on a light background. Works best with dark lines on
  white paper. The threshold slider tunes the cut-off.

## OpenProcessing

`sketch.js` is identical to what you'd paste into OpenProcessing for quick
edits — only `index.html` (and local assets) differ. One caveat: **paste-an-
image is unreliable inside OpenProcessing's iframe**, so use the GitHub Pages
copy for classroom display.
