# Third Party Notices

Haven uses locally bundled Lucide icons (ISC license), pywebview (BSD-3-Clause), Pillow (HPND), pillow-heif (BSD-3-Clause), rawpy (MIT), NumPy (BSD-3-Clause), imageio-ffmpeg (BSD-2-Clause), packaging (Apache-2.0/BSD-2-Clause), Send2Trash (BSD-3-Clause), and their dependencies. PyInstaller includes its distribution exception. Their license files are included in the installed distributions and packaged runtime where provided.

The bundled FFmpeg binary is supplied by imageio-ffmpeg. Consult its build configuration and https://ffmpeg.org/legal.html for LGPL/GPL licensing and codec patent considerations when distributing binaries.

Haven's WebGL2 liquid-glass renderer adapts the signed-distance, Snell refraction, dispersion, Fresnel and color-conversion algorithms from Liquid Glass Studio by Charles Yin: https://github.com/iyinchao/liquid-glass-studio (MIT). Upstream SDF/math/color shader helpers and their MIT license are bundled under `web/shaders/vendor/liquid-glass/`. The light/dark background bitmap assets are from the same reference repository. Its React application and WebGPU backend are not bundled. The upstream color helper preserves its original attribution to GLSL-Color-Functions.
