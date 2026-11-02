// Collect the licenses of every bundled third-party component into src/third-party-licenses.txt
// (shown in-app via More ▸ Open-source licenses, and shipped with both builds).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const nm = (p) => path.join(ROOT, 'node_modules', p);
const version = (pkg) => JSON.parse(fs.readFileSync(nm(`${pkg}/package.json`), 'utf8')).version;

const mit = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const LEPTONICA = `Copyright (C) 2001 Leptonica. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided
that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
   following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and
   the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL ANY COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.`;

const read = (p) => fs.readFileSync(nm(p), 'utf8').trim();
const parts = [
  ['pdf.js (pdfjs-dist)', version('pdfjs-dist'), 'Apache License 2.0', 'https://github.com/mozilla/pdf.js', read('pdfjs-dist/LICENSE')],
  ['pdf-lib', version('pdf-lib'), 'MIT', 'https://github.com/Hopding/pdf-lib', read('pdf-lib/LICENSE.md')],
  ['@pdf-lib/fontkit (fork of fontkit)', version('@pdf-lib/fontkit'), 'MIT', 'https://github.com/Hopding/fontkit', mit('2014 Devon Govett, Andrew Dillon')],
  ['tesseract.js', version('tesseract.js'), 'Apache License 2.0', 'https://github.com/naptha/tesseract.js', read('tesseract.js/LICENSE.md')],
  ['tesseract.js-core (Tesseract OCR engine compiled to WebAssembly)', version('tesseract.js-core'), 'Apache License 2.0', 'https://github.com/naptha/tesseract.js-core', read('tesseract.js-core/LICENSE')],
  ['Leptonica (image library inside tesseract.js-core)', '', 'BSD 2-Clause', 'http://www.leptonica.org', LEPTONICA],
  ['@tesseract.js-data/eng (English OCR model, from tesseract-ocr/tessdata, Apache 2.0)', version('@tesseract.js-data/eng'), 'MIT (package) / Apache 2.0 (model data)', 'https://github.com/naptha/tessdata', mit('tesseract.js contributors')],
  ['Electron (desktop app only)', version('electron'), 'MIT', 'https://github.com/electron/electron', `${read('electron/LICENSE')}\n\nChromium and other Electron components: see LICENSES.chromium.html inside the app bundle.`],
];

const out = `Pagewright includes the following open-source components. Thank you to their authors.\n\n`
  + parts.map(([name, v, lic, url, text]) => `${'='.repeat(78)}\n${name}${v ? ` ${v}` : ''}\nLicense: ${lic}\n${url}\n${'-'.repeat(78)}\n${text}\n`).join('\n');
fs.writeFileSync(path.join(ROOT, 'src/third-party-licenses.txt'), out);
console.log(`src/third-party-licenses.txt written (${parts.length} components)`);
