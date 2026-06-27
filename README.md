# Classroom Aquarium
https://evandevon.github.io/virtual_aquarium/

A relaxing interactive display. Kids draw fish on paper and scan them with a
webcam, paste an image, or upload a file — each creature swims around its own
little reef. Built with [p5.js](https://p5js.org/).

## Using it

- **Tap anywhere** on the intro screen to start (this unlocks audio and the
  webcam — required by browsers).
- **Preview Options**
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
- **hold still** on the water to drop food. Fish that eat **grow**. Sometimes baby fish clones are spawned
- A **shark** silhouette passes through roughly every 5 minutes; the fish flee
  and hide behind the rocks and coral. The shark never eats them.
- **Backup/Restore Tank** saves or reloads all current fish as a ZIP.

## OpenProcessing

`sketch.js` is identical to what you'd paste into OpenProcessing for quick
edits — only `index.html` (and local assets) differ. One caveat: **paste-an-
image is unreliable inside OpenProcessing's iframe**, so use the GitHub Pages
copy for classroom display.
