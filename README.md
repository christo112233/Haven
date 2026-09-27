# Haven · 本地一站式照片中枢

<p align="center">
  <img src="./docs/logo.png" alt="Haven Logo" width="160">
</p>
<p align="center">
  <strong>无云端上传 · 纯本地隐私 · 液态玻璃原生 UI · 沉浸式影像管理</strong>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011%20(x64)-0078D6?style=flat-square&logo=windows&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.14-3776AB?style=flat-square&logo=python&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=flat-square">
  <img alt="Privacy" src="https://img.shields.io/badge/Privacy-100%25%20Local-blueviolet?style=flat-square">
</p>



> **无云端上传 · 纯本地隐私 · 液态玻璃原生 UI · 沉浸式影像管理**

Haven 是一款面向 **Windows** 的轻量化本地照片、视频管理工具，基于 **Python + WebView2 + WebGL2** 构建，搭载自研苹果液态玻璃交互体系。全程无后台遥测、无强制云同步、不上传任何本地影像数据，仅版本更新功能需联网，守护你的影像隐私。

<p align="left">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011%20(x64)-0078D6?style=flat-square&logo=windows&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.14-3776AB?style=flat-square&logo=python&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=flat-square">
  <img alt="Privacy" src="https://img.shields.io/badge/Privacy-100%25%20Local-blueviolet?style=flat-square">
</p>

---

## 📑 目录

- [✨ 核心特色](#-核心特色)
- [🖥️ 快速开始](#️-快速开始)
- [📌 基础功能](#-基础功能)
- [🔄 更新机制](#-更新机制)
- [📖 开发文档](#-开发文档)
- [📄 开源许可](#-开源许可)
- [⭐ 关于项目](#-关于项目)

---

## ✨ 核心特色

| 特色 | 说明 |
| :--- | :--- |
| **极致液态玻璃交互** | 基于 WebGL2 着色器实现真实折射、色散、菲涅尔高光、动态指针反光；原生适配深浅色主题，无第三方框架冗余；低性能设备自动降级 CSS 磨砂玻璃，兼顾颜值与流畅度。 |
| **零干扰沉浸式体验** | 弱化 UI 遮挡，优先展示影像本身；闲置界面自动淡化，专注照片、视频预览与管理。 |
| **全格式影像兼容** | 图片：JPG / PNG / WebP / HEIC / TIFF / GIF；相机 RAW：CR2 / NEF / ARW / DNG 等；视频：MP4 / MOV / MKV 预览与抽帧。 |
| **纯本地隐私优先** | 所有影像文件、缓存、索引均保存在本地磁盘，不读取隐私信息、不联网上传原图，全程离线可用。 |
| **智能高效管理** | 多目录挂载、实时增量索引、虚拟滚动懒加载、可调节网格布局，支持搜索、筛选、排序，支持星级、收藏、旗标、颜色标签和标签功能，智能相册等，海量图库依旧流畅。 |
| **稳定自动更新** | 独立更新器设计，支持版本校验、SHA256 完整性校验、更新失败回滚，安全无痛迭代升级。 |

---

## 🖥️ 快速开始

### 系统依赖

| 项目 | 要求 |
| :--- | :--- |
| **适配系统** | Windows 10 / Windows 11 (x64) |
| **必需运行环境** | [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（绝大多数新版 Windows 已预装，缺失可免费安装） |

### 使用正式打包版（推荐普通用户）

1. 前往 **Releases** 下载最新版 `Haven-win64.zip`
2. 完整解压至 **非系统、可写目录**（如 `D:\Apps\Haven`）
3. ⚠️ 务必保留 `_internal/`、`updater.exe`、`version.txt` 全部文件，**不可单独移动 `Haven.exe`**
4. 双击 `Haven.exe` 即可启动使用
5. 创建 `Haven.exe` 快捷方式到桌面更便捷

### 源码运行（开发者模式）

> 本地开发、调试需 **Python 3.14** 环境，项目统一使用虚拟环境管理依赖。

```bash
# 初始化虚拟环境
python -m venv venv

# 安装全部依赖
venv\Scripts\python.exe -m pip install -r requirements.txt

# 启动程序
venv\Scripts\python.exe main.py
```

---

## 📌 基础功能

- **多目录管理** — 无限挂载本地 / 移动硬盘目录，自动监听文件变动，支持子目录递归浏览
- **沉浸式预览** — 大屏原图预览、滚轮缩放、鼠标拖拽平移、方向键切换、`ESC` 快速关闭
- **基础文件操作** — 资源管理器定位、默认程序打开、复制路径、回收站删除（带二次确认）
- **多媒体适配** — 视频抽帧预览、内嵌播放，支持 Live Photo / Motion Photo 动态影像识别
- **个性化主题** — 深色 / 浅色双主题，原生液态玻璃动态 UI，无边框轻量化窗口
- **智能缓存机制** — 增量索引、缩略图缓存、过期自动失效，大幅提升重复打开速度

---

## 🔄 更新机制

- 🚀 程序启动静默检测官方新版本，支持手动检查更新
- 🔐 完整校验更新包 **大小 + SHA256 哈希值**，杜绝损坏、篡改安装包
- 🧩 独立更新进程，支持更新失败 **自动回滚**，不损坏本地程序与用户设置
- ⚙️ 可自由开启 / 关闭自动更新，**无强制升级**

---

## 📖 开发文档

项目架构、文件说明、打包流程、自动化测试、更新机制、报错排查等完整技术文档：

➡️ **[完整开发文档 →](./docs/开发文档.md)**

适合二次开发、功能迭代、本地打包、源码学习查阅。

---

## 📄 开源许可

本项目基于 **MIT License** 开源，可自由学习、二次开发、非商用 / 商用使用。

第三方依赖、着色器代码、图标库许可详见 **[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)**。

---

## ⭐ 关于项目

Haven 致力于打造一款 **隐私安全、颜值极致、流畅好用** 的本地影像管理工具。摒弃臃肿冗余功能，专注「纯粹看图、高效管理、极致视觉体验」。

后续将持续迭代更多实用功能，敬请期待。

> 💡 如果 Haven 对你有帮助，欢迎点一个 **Star** ⭐ 支持项目持续更新～

---

<p align="center">
  <sub>Made with ❤️ by Haven</sub>
</p>