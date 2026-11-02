# Pagewright

A local macOS PDF reader/editor (Electron + pdf.js + pdf-lib + tesseract.js). Everything runs on your Mac and nothing is uploaded. There are no accounts, watermarks or paywalls.

```bash
npm start            # run the app
npm run smoke        # end-to-end test (26 checks), artifacts in $SMOKE_OUT or /tmp
npm run dist         # build dist/mac-arm64/Pagewright.app (electron-builder, unsigned)
```

### Install / update the app

```bash
npm run dist && codesign --force --deep --sign - "dist/mac-arm64/Pagewright.app" && rm -rf "/Applications/Pagewright.app" && ditto "dist/mac-arm64/Pagewright.app" "/Applications/Pagewright.app"
```

To make it the default PDF app: in Finder, select any PDF, press ⌘I, choose **Pagewright** under "Open with", then click **Change All…**.

To smoke-test the installed app: `PAGEWRIGHT_SMOKE=$PWD/test/smoke.js "/Applications/Pagewright.app/Contents/MacOS/Pagewright" --smoke`

## iPhone / iPad (home-screen web app)

```bash
npm run build:web    # → web-dist/ (static files, ~17.5 MB, works fully offline after first visit)
```

`web-dist/` is a static site. Host it anywhere that serves HTTPS (GitHub Pages, Netlify, Cloudflare Pages); offline caching needs HTTPS. On the iPhone, open the URL in Safari, tap **Share → Add to Home Screen**, and launch it from the icon. PDFs open from Files, iCloud Drive or other apps via the open button, and **Save** hands the file to the share sheet (Save to Files, Mail, AirDrop). Nothing is uploaded; the site only delivers the app's code.

Phone differences from the Mac app:
- The tool row scrolls sideways, and the page list is a drawer (top-left button).
- Pinch zooms. Drag a box over text to highlight it. Tap a selected text box again to edit it.
- In the organizer, tap pages to select them and use ◀ ▶ to move them.
- No "Open in…" integration with other iPhone apps, and characters outside the standard PDF fonts (e.g. ✓) save as "?".

## What it does

| Area | Features |
|---|---|
| Read | Fast rendering, thumbnails, bookmarks, links, fit width/page, ⌘-scroll zoom, find (⌘F), text selection & copy |
| Annotate | Highlight / underline / strikethrough over real text (or drag a box on scans), sticky-note comments (saved as real PDF comments), pen, rectangle, ellipse, line, arrow |
| Edit | Add text (fonts, size, bold/italic, colour, any Unicode), **edit existing text** (click a line, which samples its font and colour), white-out, images (open, paste or drag in), signatures (draw / type / image, remembered), stamps |
| Organize | Drag to reorder (sidebar or grid), rotate, duplicate, delete, insert blank, insert from file, extract selected, combine files, split by every-N or ranges |
| Forms | Fill AcroForm fields in place; optional flatten on save |
| Convert | OCR scanned pages (offline, English) into searchable text, export pages as PNG/JPEG, export text, compress (lossless or image-based), true redaction, edit metadata, print |

Keys: V select · H pan · T text · E edit text · P pen · N note · U highlight · R rect · O ellipse · L line · A arrow · ⌫ delete · arrows nudge · ⌘D duplicate · ⌘C/⌘V copy/paste markup or images.

## How saving works

The app keeps your original file untouched in memory. When you save, it rebuilds the PDF from that original plus your edits. The first source file is edited in place, so bookmarks, metadata and form fields survive. Markup is flattened into the page content. Sticky notes stay as real PDF comments. Form values typed into fields are written back as real field values.

## Known limits

- **Edit text** works by covering the original line and writing replacement text in the closest standard font (Helvetica, Times or Courier). It does not reflow paragraphs, and it can't reproduce an embedded custom font exactly.
- **Markup is flattened on save.** After reopening a saved file you can't move or delete earlier highlights and shapes. Sticky notes stay editable.
- **Redacted pages are rasterised** (at 200 dpi) so the hidden content is really gone. Text on those pages stops being selectable until you run OCR.
- **Password-protected or encrypted PDFs** open after you enter the password. Their pages are saved as images, because pdf-lib can't re-encrypt or decrypt the content streams.
- **OCR is English only.** Other languages can be added with more `@tesseract.js-data/*` packages.

## License

Pagewright is released under the [MIT License](LICENSE). It bundles open-source components (pdf.js, pdf-lib, fontkit, Tesseract/tesseract.js, Leptonica, Electron) under their own licenses. Their notices are in [src/third-party-licenses.txt](src/third-party-licenses.txt) and in the app under ⋯ ▸ Open-source licenses. Regenerate them with `npm run licenses`.
