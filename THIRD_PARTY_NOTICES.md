# Third Party Notices

Haven uses locally bundled Lucide icons (ISC license), pywebview (BSD-3-Clause), Pillow (HPND), pillow-heif (BSD-3-Clause), rawpy (MIT), NumPy (BSD-3-Clause), imageio-ffmpeg (BSD-2-Clause), packaging (Apache-2.0/BSD-2-Clause), Send2Trash (BSD-3-Clause), and their dependencies. PyInstaller includes its distribution exception. Their license files are included in the installed distributions and packaged runtime where provided.

The bundled FFmpeg binary is supplied by imageio-ffmpeg. Consult its build configuration and https://ffmpeg.org/legal.html for LGPL/GPL licensing and codec patent considerations when distributing binaries.

---

## 观片台 / LightTable (MIT)

Haven's light table mode (dark-room viewing, lamp response timing, normalized
photo placement, loupe geometry and the space-to-look-closer interaction) is
inspired by the macOS app 观片台 / LightTable:

- https://github.com/fuyuan9972-svg/LightTable
- Copyright (c) 2026 fuyuan9972-svg
- Licensed under the MIT License (the app's own source code; the EDR binary,
  audio files, SHARP model weights and third-party assets are not MIT licensed
  and are not used by Haven).

Haven's implementation is an independent JavaScript rewrite for the web
frontend; no LightTable binary, asset, audio file or model is bundled.

MIT License text, as required for the portions of that project whose
interaction model was ported:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
