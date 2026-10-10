# Diagram Cropper

Crop question diagrams out of a PDF and save each one straight into your images folder under the exact file name from your list or Excel sheet.

Everything runs in your browser. There is no login and no upload. The only server is a tiny local one on your own computer.

## How to run

You need [Node.js](https://nodejs.org) (any recent version) and **Chrome or Edge**.

- **Windows:** double-click `start.bat`.
- **Any system:** open a terminal in this folder and run `node server.js`.

The app opens at <http://localhost:5173>. Keep the terminal window open while you work.

No `npm install` is needed to use the app, because the libraries (pdf.js, SheetJS, JSZip) are already in `vendor/`.

> Firefox and Safari can't save straight into a folder. In those browsers the app downloads each image, with the correct name, to your Downloads folder, and it tells you so at the start.

## How to use it in 5 steps

1. **Choose the images folder.** Click **Choose images folder** and allow editing when the browser asks. Images already in the folder are marked **Done**, so you can pick up where you left off on another day.
2. **Load the names.** Paste the names (one per line) or upload your Excel file. The image-name, question-number and question-text columns are found automatically, and you can change them from the drop-down lists. Problem names (spaces, capital letters, special characters, very long names, repeats) are listed. Click **Fix automatically** if you want them fixed; nothing is renamed without you asking.
3. **Open the PDF.** All pages show in one long scroll. Zoom with Ctrl + mouse wheel or the − / + buttons.
4. **Crop.** The name at the top is the one that will be saved. **Click once on its diagram** and the box snaps around it, labels and caption included. Or drag a box yourself. Adjust the box with the handles if needed, then click **Approve** (or press Enter). The file is saved, and the next pending name becomes active. Click **Retake** (or press Esc) to try again.
5. **Finish and check.** Click **Finish and check** to see what is done, skipped and still pending. Then click **Check that every name has a file** and download the CSV report, the ZIP, or the updated Excel (with an image status column).

### Automatic names (no list needed)

By default each crop is named **page_question_figure.png**, for example `3_12_1.png` for the first diagram of Q12 on page 3. You don't need to load a names list. Just choose the folder, open the PDF, and crop.

- **Page** is the page the box is on.
- **Question** is the nearest question number ("Q12", "12." or "12)") above the box in the PDF text. If none is above it on that page, the last one on an earlier page is used.
- **Figure** counts up for each image of the same question on the same page (1, 2, …) and never overwrites an existing file.

All three show in the crop panel, so you can correct them before you approve. Scanned PDFs have no text, so type the question number there. To use your own names from a list or Excel, untick **Settings → Name each crop automatically**.

### Click to crop

One click inside a diagram, on a line or in an empty space inside it, selects the whole diagram:

- It finds the drawing's edges, even on grey, shadowed or tilted phone photos.
- It keeps labels and a caption line such as "Fig. 1" just above or below.
- It leaves out the question text and any neighbouring diagram.
- A small margin is added around the box. You can still adjust it with the handles, or drag your own box at any time.
- Clicking empty paper selects nothing and tells you so.

To turn it off, untick **Settings → Click a diagram to select it automatically**.

### Checks that stop mistakes

- **Finds the question for you.** The app searches the PDF's text for the active question, first by its opening words from the Excel and then by its number. The toolbar shows "Q12 is on page 3", the page gets a yellow **▶ Q12** marker, and the view scrolls there if it isn't already on screen. You can turn off the scrolling in Settings. Scanned PDFs with no text can't be searched, and the app tells you so.
- **Checks each crop before you approve it.** The panel warns when:
  - the box cuts through the diagram (ink touches an edge);
  - the box holds a lot of question text;
  - the image is very small;
  - the same area was already saved under another name;
  - the box is on a different page from the question.

  An empty box can't be approved at all.
- **Replace from the old box.** Click a Done name, or **Replace this image**, and its saved box reappears on the page, so you only need to adjust it.
- **Review saved images.** A grid of every saved image beside its name, question number and question text, so a mismatch is easy to spot. Tick **Only images with warnings** to see just the ones to recheck. Warnings are also marked "⚠ check" in the list and appear in the CSV report.
- **Sharp output.** Crops are drawn fresh from the PDF at 300 dpi by default (Settings → Sharpness of the crop), then limited to the largest width.

### Cleaning up phone photos (image editing)

Every crop is cleaned automatically with the **preset** chosen in the top bar. The default, **Phone photo - clean**, turns grey or yellow paper white, removes shadows, and sharpens lines. The panel preview shows the result, so most of the time you just press **Approve**.

When a crop needs more work, click **Edit** in the panel, or double-click the preview. The editor has:

- **Clean-up tools:**
  - erase brush (size, soft or hard edge);
  - erase box, lasso erase, and "keep only this area";
  - clone/patch (click a clean spot, then paint over the blemish);
  - protect area (the automatic clean-up never changes it).
- **Background and clarity:**
  - modes: Original, Enhanced colour, Grayscale, Black and white, Line art;
  - white background, shadow removal, keep coloured lines, Auto enhance;
  - brightness, contrast, gamma, exposure, highlights, shadows, white and black point, sharpness, denoise, despeckle, and black-and-white strength. Each slider shows its number and has a reset button.
- **Geometry:** rotate 90°, flip, fine rotate (−15° to +15°, with a grid), **Auto deskew**, perspective correction (drag 4 corners), fine crop (handles or arrow keys), auto trim, padding (0–40 px), largest width and height.
- **Output:** PNG, PNG-8 (much smaller for simple diagrams), or JPG with a quality slider. The final size in pixels and KB shows before you save.
- **Compare and undo:** hold to compare, split view, side by side. Undo and redo (Ctrl+Z / Ctrl+Y) cover every step, and **Reset to original** removes all edits.

Editing never changes the original. Each image stores its original crop, its preset, anything changed just for it (the list and gallery show a **custom** badge), and its edit steps. The final image is always made again from these at full resolution.

**Presets and settings** (the **Settings** button):

- **Built-in presets:** Phone photo - clean, Scanned - light, Coloured diagram, Text-heavy (black and white), and No changes (digital PDF).
- **Manage presets:** create your own presets, set one as the default, rename or delete them, and export or import everything as a JSON file.
- **Stored originals:** see how much browser storage the original crops use, with a **Clear originals** button.

**Many images at once:**

- In the editor, **Apply these settings to all remaining images** (or to all images, including Done), and **Copy settings** / **Paste settings**.
- In **Review saved images**, tick images, pick a preset, and click **Re-process selected**. The files are re-made from the stored originals, with the same names, and a progress bar shows how far along it is.
- After each save, images that look nearly blank, very dark, very small or blurry are flagged. Tick **Only images that need a look** to see just those.

### How the clean-up keeps quality

- **Clean digital PDFs are left untouched.** If a crop already has white, grain-free paper, it keeps its exact colours and light fills. Only trim, padding and size are applied. You can switch this off with the setting "Leave clean crops untouched".
- **Phone photos:**
  - The paper tint is measured, and only patches with that tint count as paper, so light-coloured fills are kept instead of being washed out.
  - Grain is measured on each crop and smoothed with an edge-preserving filter that also removes single-pixel spikes.
  - Paper becomes pure white only where the surrounding area is bright, neutral and free of ink, so the soft edges of lines stay smooth.
  - Sharpening works on brightness only (no colour fringes) and ignores differences at grain level.
  - Dust specks are removed only from paper; grain inside coloured fills is never turned white.
- **Small diagrams** are drawn from the PDF with more pixels (up to 576 dpi), so their longest side is at least 1000 px before resizing.

`tests/unit-quality.mjs` checks this on synthetic diagrams with known answers: a clean crop comes out unchanged, and on a phone photo the paper is white, the fill colour is kept, grain drops by more than half, and line edges are straight. `node tests/quality-dump.mjs <folder>` saves sample crops, and their originals, so you can look at them side by side.

### Handy extras

| What | How |
|---|---|
| Skip a name (with an optional note such as "not in PDF") | **Skip** button or **S** |
| Undo the last save or skip (puts back any file it replaced) | **Undo** button or **Ctrl+Z** |
| Replace an image | Click the name in the list, then crop and Approve again |
| Save the same image under a second name | **Use for another name** on the "Saved" card, in the top bar for a Done name, or in the enlarged view |
| A diagram split across two pages | Drag the box across the page break; the two parts are joined into one image |
| Find a name | Type part of the name or the question number in the search box and press Enter |
| See a saved image and its PDF page | Click its thumbnail in the list |
| Keep files small / tidy | In the preset: largest width (1200 px by default), auto trim, white padding (10 px), PNG-8 format |
| Save or move your progress | **Finish and check → Save backup (JSON)** and **Restore from backup** |

Progress is saved in the browser automatically. If you refresh the page, it comes back, the last PDF reopens, and you get a **Reconnect folder** button if the browser needs your permission again.

Images are saved as PNG. A name ending in `.jpg` is saved as JPEG.

## Tests (for developers)

```
npm install                    # playwright-core + xlsx, only needed for tests
node tests/make-samples.mjs    # builds samples/sample-questions.pdf and .xlsx
npm test                       # name unit tests + full browser test (uses installed Edge)
```

The browser test chooses a folder, loads the sample Excel, approves 3 crops, retakes 1, reuses one image for a second name, undoes it, skips one, crops across a page break, and then refreshes. It checks the exact file names, that the next name becomes active each time, that progress comes back after the refresh, the verification report, and every download. Set `PW_CHANNEL=chrome` to use Chrome, or `HEADED=1` to watch it run.

`tests/e2e-click.mjs` clicks 7 diagrams on the clean PDF and 5 on the phone PDF. It checks that each box lands within 3–4 mm of the drawing's real edges, with no question text and no neighbouring diagram.

`tests/e2e-editor.mjs` uses `samples/phone-questions.pdf`, which has pages that look phone-captured: yellowish paper, shadows, grain, blur, and tilts of +3° and −2°.

1. It crops 3 diagrams and checks that the default preset gives a white background with dark, sharp lines.
2. It erases a stray piece of the neighbouring diagram and fixes the tilt with Auto deskew (it finds −2.95°).
3. It creates a preset, applies it to all remaining images, and re-processes two Done images (the files are updated in place).
4. It exercises every tool, mode and output format.
5. It refreshes, checks that settings and presets come back, and round-trips a settings export and import.

A script can't click the browser's folder picker, so the test points it at a folder in the browser's private storage. That folder uses the same File System Access API and the same app code as a real folder.

## Files

```
index.html, styles.css   the page
js/main.js               app state, screens, saving, undo, reports
js/viewer.js             PDF scroll view, zoom, crop box, high-resolution crop rendering
js/names.js              cleaning and checking names, reading Excel columns
js/folder.js             writing to the folder (or downloading as a fallback)
js/editor.js             the image editor and the shared settings controls
js/pipeline.js           image processing: geometry, deskew, background, tone, modes, clean-up, trim, resize
js/process-worker.js     runs the pipeline in the background (with per-stage caching)
js/processor.js          talks to the workers (one for previews, one for full-size saves)
js/presets.js            settings, built-in presets, per-image changes
js/png8.js               palette PNG encoder
js/image.js              crop checks (empty, cut off at an edge)
js/exports.js            CSV, updated Excel, backup
vendor/                  pdf.js 4.10, SheetJS 0.18, JSZip 3.10
server.js, start.bat     local server
```
