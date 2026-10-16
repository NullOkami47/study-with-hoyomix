<div align="center">

<img src="public/pwa-icon.svg" width="128" height="128" alt="Study with HOYO-MiX icon" />

# Study with HOYO-MiX

**一个以 HOYO-MiX 音乐陪伴学习的非官方粉丝项目。**

<p align="center">
  <a href="./README.md">English</a> |
  <strong>简体中文</strong> |
  <a href="./README.zh_TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/NullOkami47/study-with-hoyomix/commits/main"><img src="https://img.shields.io/github/last-commit/NullOkami47/study-with-hoyomix/main?style=flat-square" alt="GitHub last commit" /></a>
  <a href="https://github.com/NullOkami47/study-with-hoyomix/stargazers"><img src="https://img.shields.io/github/stars/NullOkami47/study-with-hoyomix?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://app.study-with-hoyomix.workers.dev"><img src="https://img.shields.io/badge/Live_App-app.study--with--hoyomix.workers.dev-32b8c6?style=flat-square" alt="Live App" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white" alt="Vue 3.5" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.6" />
  <img src="https://img.shields.io/badge/Vite-8.3-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite 8.3" />
  <img src="https://img.shields.io/badge/Cloudflare-Workers_%26_D1-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers & D1" />
</p>

<p align="center">
  <a href="#screenshots">界面预览</a> •
  <a href="#capabilities">核心能力</a> •
  <a href="#implemented">已实现功能</a> •
  <a href="#planned-features">未来计划</a> •
  <a href="#tech-stack">技术栈</a> •
  <a href="#quick-start">快速开始</a> •
  <a href="#project-layout">目录结构</a> •
  <a href="#credits">致谢</a> •
  <a href="#links">友链</a> •
  <a href="#license">开源协议</a>
</p>

</div>

---

## 📝 项目简介

**Study with HOYO-MiX**（[`NullOkami47/study-with-hoyomix`](https://github.com/NullOkami47/study-with-hoyomix)）是 [`NullOkami47/hoyomix_web_player`](https://github.com/NullOkami47/hoyomix_web_player) 的公开开源版本——一个以 **HOYO-MiX** 游戏原声音乐陪伴学习与专注的非官方深色系 Web 工作台。项目围绕 WebGPU / WebGL2 / CSS **Liquid Glass（液态玻璃）** 光学材质构建，内置持久化番茄钟与睡眠定时器、多音源播放编排引擎、基于原生 `IndexedDB` 的匿名本地优先曲库与可选 OAuth 跨设备云同步，以及基于 Cloudflare Workers + D1 + R2 + Durable Objects 的边缘后端架构。

公开生产环境应用部署于 **[Study with HOYO-MiX](https://app.study-with-hoyomix.workers.dev)**，由 Cloudflare Worker `app` 提供服务。

- [构建与本地开发指南 (`BUILDING.txt`)](https://github.com/NullOkami47/study-with-hoyomix/blob/main/BUILDING.txt)
- [源码与开源许可声明 (`NOTICE`)](https://github.com/NullOkami47/study-with-hoyomix/blob/main/NOTICE)
- [第三方开源声明 (`docs/THIRD_PARTY_NOTICES.md`)](docs/THIRD_PARTY_NOTICES.md)

> [!IMPORTANT]
> **非官方粉丝项目与公开开源发行声明**
>
> - **非官方与非商业性质**：Study with HOYO-MiX 是一个独立的、非商业性质的粉丝自制学习陪伴项目，与米哈游（HoYoverse / miHoYo / Cognosphere）或 HOYO-MiX **不存在任何隶属、背书、赞助或授权关系**。相关游戏名称、角色与音乐商标均归其各自权利人所有。
> - **不含受版权保护的媒体与线上凭据**：本公开开源发行版**刻意不包含任何原声音乐曲库、受版权保护的游戏美术封面、动态游戏壁纸、用户数据、默认第三方音源脚本或线上服务密钥**。随附的初始曲库（`src/features/catalog/catalog.production.json` 与 `src/features/catalog/catalog.sample.json`）及静态背景定义（`src/features/backgrounds/staticDefinitions.ts`）默认为空，供自托管部署者自行配置其拥有合法使用权的媒体资源与外部服务凭据。

> [!WARNING]
> **第三方音乐源与外部服务免责声明**
>
> 第三方音乐源（包括用户个人 ChKSz API Key 以及可选外部解析服务）均依赖非本项目控制的外部服务。第三方接口可能因限流、地区限制、DNS/证书错误或上游变更而失效。导入或启用第三方音源完全属于用户的个人行为，请遵守当地法律法规、目标平台服务条款与音乐版权规范。

<a id="screenshots"></a>
<a id="zh-cn-screenshots"></a>

## 📸 界面预览

### 桌面版截图

| 主页 | 音乐库 |
| :---: | :---: |
| ![主页](docs/screenshots/desktop-workspace.png) | ![音乐库](docs/screenshots/desktop-library.png) |

### 手机版截图

| 主页 | 播放队列 |
| :---: | :---: |
| ![主页](docs/screenshots/mobile-workspace.png) | ![播放队列](docs/screenshots/mobile-queue.png) |

<a id="capabilities"></a>
<a id="zh-cn-capabilities"></a>

## ⚡ 核心能力

| 模块领域 | 功能说明 |
| :--- | :--- |
| **液态玻璃工作台** | 双槽位无缝交叉淡入淡出视频/海报背景舞台（默认 `1080p30`，可选 `1440p30` 高清源并在掉帧时自动回退），底层采用多通道 WebGPU / WebGL2 光学折射着色器（`StudioGlassCanvas`、`LiquidGlassCanvas`）及无依赖 CSS 降级方案 |
| **持久化计时与学习统计** | 基于单调时钟的番茄工作法计时器（`focus`、`short-break`、`long-break`，支持休息阶段自动暂停/恢复音乐租约）、持久化睡眠定时器（`15` / `30` / `45` / `60` / `90` 分钟预设与自定义时长）以及 `StudyCalendar` 学习打卡统计 |
| **多维曲库与虚拟化队列** | 支持按游戏（`genshin`、`hsr`、`zzz`）、氛围模式（`sleep`、`focus`、`chill`）与关联类型（`place`、`character`、`npc`、`faction`、`event`）筛选，结合 `opencc-js` 实现简繁共通标题/别名搜索，并提供可自由调整尺寸的虚拟滚动队列 |
| **多音源播放编排** | 统一调度服务端与浏览器端音源适配器（`r2`、`jellyfin`、`youtube`、`chksz`、`meting`、`gd-studio`、`huanyin`、`qijie`、`piped`、`invidious`、`lx`、`lx-user`），支持故障自动回退、系统 MediaSession 集成与实时延迟/错误码诊断 |
| **QuickJS 自定义音源沙箱** | 支持导入兼容 LX Music 规范的 JavaScript 音源脚本，在独立 Web Worker + `quickjs-emscripten-core` WebAssembly 沙箱（`src/features/player/lx/runtime/`）中受限执行，强制限制内存、调用栈、超时与响应载荷体积 |
| **本地优先曲库与云同步** | 免登录即可通过浏览器原生 `IndexedDB` 与 `localStorage` 保存收藏曲目、自建歌单、可选播放历史（最多保留 100 条）与界面偏好；支持通过 **Google**、**GitHub**、**LINUX DO** 登录并将数据同步至 Cloudflare D1 |
| **实时自习室与管理后台** | 基于 Cloudflare Durable Objects（`OnlineCounter`）实现实时在线人数统计与公共自习聊天室；内置权限隔离的 `AdminShell`，支持管理曲库版本、Google Sheets 导入、R2 背景视频 WebCodecs 转码（`mediabunny`）、全站公告与音源健康度 |

<a id="implemented"></a>
<a id="zh-cn-implemented"></a>

## ✨ 已实现功能

#### 播放器、队列与音质模型

- **紧凑单行与原地展开 `PlayerBar`**：默认单行展示安全封面回退、规范曲目标题、当前音源标识、播放/暂停与下一首按钮；展开后原地显示进度条、缓冲状态、音量、队列开关、音源切换与 `PlaybackDiagnostics` 诊断详情。
- **非模态可调尺寸 `QueuePanel`**：表头固定显示随机（`Shuffle`）与循环（`Repeat`）状态，上方为历史播放记录（`Previously Played`），中间固定“正在播放”（`Now Playing`）行，下方为虚拟滚动的“待播列表”（`Up Next`），支持 44 px 触控/键盘排序与桌面端左下角手柄自由缩放。
- **抽屉挂起不变式（Sheet Suspension）**：打开任意模态面板（`SettingsSheet`、`LibrarySheet`、`ControlCentre`）时自动记录播放意图并安全暂停官方 YouTube IFrame 实例，关闭面板后精确恢复一次播放状态。
- **音质档位选择（`src/features/player/qualityPreferences.ts`）**：
  - **ChKSz 音质模型（`src/shared/chksz.ts`）**：`standard`（标准）、`exhigh`（极高）、`lossless`（无损）、`hires`（Hi-Res）、`jyeffect`（高清环绕声）、`sky`（沉浸环绕声）、`jymaster`（超清母带）。
  - **LX 自定义音源档位**：`standard`、`high`、`lossless`、`hires`。
  - 当目标音质不可用时自动降级至可用资源，并在界面展示实际解析返回的音质元数据。

#### 第三方音乐源与安全边界

- **本地协议授权开关**：第三方解析源（`chksz`、`lx-user` 等）需在设置中阅读并同意本地《第三方音源协议》（`ThirdPartyAgreement.vue`）后方可启用，开关状态完全由本地控制。
- **QuickJS WASM 运行时（`src/features/player/lx/runtime/`）**：在独立模块 Worker 中加载 `quickjs-emscripten-core` 与 `@jitl/quickjs-wasmfile-release-asyncify`（`0.32.0`），严格执行 `protocol.ts` 定义的内存上限、栈深、执行超时与桥接响应大小限制。
- **ChKSz 个人凭据支持**：支持用户在应用内配置个人 `chksz_` API Key（需通过 LinuxDo 账号在 `api.chksz.com` 注册），客户端与 Worker 端共享同一套 SSRF 与媒体域名校验策略（`src/shared/chksz.ts`）。

<a id="planned-features"></a>
<a id="zh-cn-planned-features"></a>

## 🗂️ 未来可能添加功能 (新建文件夹中)

- **聊天室**
- **更多曲目（包括同人音乐）**
- **更多第三方音乐来源**：支持更多第三方音乐来源，例如 LX Music
- **更好的液态玻璃 UI**
- **绝区零风格（电视机） UI**
- **原神风格 UI**
- **崩坏：星穹铁道风格 UI**
- **平滑过渡**
- **智能混音**

<a id="tech-stack"></a>
<a id="zh-cn-tech-stack"></a>

## 🛠️ 技术栈

| 层级 | 技术实现 |
| :--- | :--- |
| **前端框架与响应式** | Vue 3.5 (Composition API, `<script setup>`), `@vueuse/core`, TypeScript 5.6, Vite 8.3 |
| **液态玻璃与样式** | 自定义 CSS 设计令牌 (`src/styles/tokens.css`), WebGPU / WebGL2 多通道着色器 (`src/features/liquid-glass/`), Lucide Vue Next |
| **播放与媒体处理** | `HTMLAudioElement`, 官方 YouTube IFrame Player API, MediaSession API, `mediabunny` 1.61.1 (WebCodecs 视频转码与 MP4 校验) |
| **自定义音源沙箱** | Web Worker + QuickJS WebAssembly (`quickjs-emscripten-core` & `@jitl/quickjs-wasmfile-release-asyncify` `0.32.0`) |
| **检索与国际化** | 三语国际化 (`en`, `zh-Hans`, `zh-Hant`), `opencc-js` 1.4.2 + 预计算 CJK 简繁折合表 (`src/features/catalog/hanFold.ts`) |
| **本地持久化** | 浏览器原生 `IndexedDB` (`src/features/library/localRepository.ts`, `src/features/focus/localRepository.ts`), `localStorage` (`src/utils/safeStorage.ts`), PWA (`vite-plugin-pwa`) |
| **边缘后端与存储** | Cloudflare Workers (`workers/index.ts`), Durable Objects (`workers/online-counter.js`), Cloudflare D1 (SQLite), Cloudflare R2 |
| **认证与安全防护** | OAuth 2.0 / OIDC (Google, GitHub, LINUX DO), HMAC-SHA256 会话签名与媒体票据, 严格的 Origin / CSRF / SSRF 防护 |
| **测试与工程化** | Vitest, `@vue/test-utils`, `fake-indexeddb`, `jsdom`, Miniflare, Wrangler 4 |

<a id="quick-start"></a>
<a id="zh-cn-quick-start"></a>

## 🚀 快速开始

#### 1. 环境要求

- **Node.js** `22.18.0` 或更高版本（推荐使用 **Node.js 24 LTS**）
- **npm**（随 Node.js 附带）
- **Git**

#### 2. 安装依赖与启动前端开发

```bash
# 严格按照 package-lock.json 安装依赖
npm ci

# 启动本地 Vite 开发服务器（自动解码生成 PWA 图标与构建信息）
npm run dev
```

常用检查、测试与构建命令：

```bash
npm run typecheck     # 生成构建信息并运行 vue-tsc + tsc 静态类型检查
npm test              # 运行前端 Vitest 单元与组件测试
npm run test:workers  # 使用 Miniflare/Vitest 运行 Cloudflare Worker + D1 集成测试
npm run build         # 解码生成 PWA 图标、构建信息并将前端产物打包至 dist/
npm run preview       # 本地预览前端构建产物
npm run verify        # 依次执行 typecheck、前端测试、Worker 测试与生产构建
```

#### 3. 本地登录按钮预览 (`HOYOMIX_DEV_AUTH_PREVIEW`)

正常执行 `npm run dev` 会将认证请求交给下游后端处理。若希望在无需真实认证的情况下预览全部三个登录按钮（`Google`、`GitHub`、`LINUX DO`），请在开发服务器的进程环境中显式设置 `HOYOMIX_DEV_AUTH_PREVIEW=1`：

```powershell
$env:HOYOMIX_DEV_AUTH_PREVIEW = '1'
try { npm run dev } finally { Remove-Item Env:HOYOMIX_DEV_AUTH_PREVIEW }
```

```sh
HOYOMIX_DEV_AUTH_PREVIEW=1 npm run dev
```

仅精确值 `1` 会启用该 Mock；未设置、`0` 或 `true` 均保持关闭。请勿将其写入受版本控制的环境文件（Vite `.env` 文件不会启用该模式）。它仅对处于 `development` 模式的 Vite 开发服务器生效，绝不会在生产或预发布构建、已部署环境或 `npm run preview` 中生效。

该 Mock 仅拦截精确的 `GET /api/auth/providers`（返回三个可用提供商）、`GET /api/session`（返回未登录 `401`）以及 `GET /api/auth/{google,github,linuxdo}/start`（返回纯文本 `501` 说明未执行真实 OAuth）。支持携带查询参数（包括身份绑定查询参数）。响应头包含 `X-Hoyomix-Dev-Auth-Mock: 1`，JSON 响应体包含 `mock: true`。启动接口不会重定向、创建 Cookie/Token、登录或绑定身份；其余请求方法与路由（含尾部斜杠与回调地址）均继续向下游转发。

#### 4. 重新生成 PWA 图标

安装图标以纯文本 Base64 源码形式存储在 Git 中（`scripts/pwa-icons/pwa-icon-192.png.base64.txt` 与 `scripts/pwa-icons/pwa-icon-512.png.base64.txt`），以便拒绝二进制补丁的代码审查系统也能完整传递 PWA 变更。生成的 PNG 光栅文件已被 Git 忽略。

当需要光栅图标文件时，可直接运行解码器：

```bash
npm run generate:pwa-icons
```

`npm run dev` 与 `npm run build` 会自动运行该解码器。解码器在写入 `public/pwa-icon-192.png` 与 `public/pwa-icon-512.png` 之前，会校验 Base64 语法、PNG 签名、声明尺寸与 SHA-256 摘要。

#### 5. 完整本地 Worker + D1 后端联调环境

如需在本地运行完整的 Cloudflare Worker + 前端联调环境：

1. 将 `.dev.vars.example` 复制为 `.dev.vars`（已被 Git 忽略）。
2. 在 `.dev.vars` 中生成相互独立的 `SESSION_HMAC_SECRET` 与 `OAUTH_STATE_SECRET`（每个至少 32 随机字节）。切勿使用客户端 `VITE_` 变量存放密钥。
3. 可选 OAuth 与 Owner 引导：通过 `workers/auth/types.ts` 与 `workers/index.ts` 中的可选字段配置您自己的 OAuth 应用凭据（`GOOGLE_*`、`GITHUB_*`、`LINUXDO_*`），并通过 `OWNER_PROVIDER` 与 `OWNER_SUBJECT` 显式指定管理员身份；保持未设置即可关闭登录提供商。
4. 初始化本地空白 D1 数据库、构建前端并启动 Wrangler：

```bash
npm run d1:migrate:local
npm run build
npm run dev:worker
```

打开 `http://localhost:8787` 即可访问。仓库内置的 `wrangler.toml` 仅指向本地开发资源。

#### 6. 配置自有媒体与音源（开源发行版说明）

由于公开开源版本默认提供空白初始曲库与背景列表：

- **音乐曲库**：按照 `src/features/catalog/schema.ts` 定义的数据结构填充 `src/features/catalog/catalog.production.json`（及 `catalog.sample.json`），或通过 `workers/catalogue/` 使用曲库管理后台与可选的 Google Sheets 导入功能。新增曲目文本后如需重新生成可选的汉字简繁折合表，可运行 `node scripts/generate-han-fold-table.mjs`。
- **音乐源服务**：在 `src/features/player/providers/registry.ts`、`workers/providers/routing.ts`、`workers/providers/config.ts` 与 `workers/index.ts` 中按需启用并配置您自己的 Jellyfin、R2 或解析服务资源。
- **背景舞台**：如需添加可再分发的静态背景，请更新 `src/features/backgrounds/staticDefinitions.ts` 并将对应资源放入 `public/` 目录；上传动态视频背景则需显式配置 `BACKGROUND_BUCKET` R2 存储桶绑定。

<a id="project-layout"></a>
<a id="zh-cn-project-layout"></a>

## 📁 目录结构

```text
study-with-hoyomix/
├── docs/
│   ├── licenses/                 # MIT、Apache-2.0 与运行时依赖许可证全文
│   └── THIRD_PARTY_NOTICES.md    # 上游项目与第三方开源组件归属声明
├── migrations/                   # Cloudflare D1 SQLite 数据库迁移脚本 (0001–0028)
├── public/                       # PWA 清单、robots.txt、SVG 图标与标题缓存辅助脚本
├── scripts/
│   ├── pwa-icons/                # Base64 编码的 192px 与 512px PNG 图标源码
│   ├── generate-build-info.mjs   # 构建元数据生成脚本
│   ├── generate-han-fold-table.mjs # OpenCC CJK 简繁搜索折合表生成工具
│   ├── generate-pwa-icons.mjs    # 带 SHA-256 校验的 Base64 转 PNG 解码器
│   └── public-notices.ts         # 提供 /legal/*.txt 法律声明路由的 Vite 插件
├── src/
│   ├── components/shell/         # 无障碍 AppShell 应用外壳与跳转链接
│   ├── features/
│   │   ├── account/              # OAuth 会话、多平台身份绑定与 D1 偏好/曲库同步
│   │   ├── admin/                # AdminShell 管理后台（曲库、背景、公告、音源健康度）
│   │   ├── backgrounds/          # 双槽位视频/海报背景状态库与 staticDefinitions.ts
│   │   ├── catalog/              # 曲库 Schema 校验、多维筛选器、OpenCC 与汉字折合检索
│   │   ├── chat/                 # FloatingChatWindow 实时自习聊天窗与安全停靠布局
│   │   ├── focus/                # 番茄钟记录器、StudyCalendar 学习日历与本地/远程仓储
│   │   ├── legal/                # FanProjectNotice 粉丝项目声明组件与状态库
│   │   ├── library/              # MusicLibrary 音乐库、专辑卡片、IndexedDB 仓储与合并弹窗
│   │   ├── liquid-glass/         # WebGPU/WebGL2 多通道着色器、StudioGlassCanvas 与 NOTICE.md
│   │   ├── notices/              # 系统公告中心 (NoticeCentre) 与历史公告
│   │   ├── player/               # PlayerBar、QueuePanel、QuickJS LX 沙箱与多音源适配器
│   │   ├── settings/             # 统一八分区 SettingsSheet、LxSourceManager 与第三方协议
│   │   ├── timers/               # 基于单调时钟的持久化番茄钟与睡眠定时器状态库
│   │   └── workspace/            # StudyWorkspace 主工作台、FocusBar、ControlCentre、背景舞台
│   ├── i18n/                     # 三语国际化词条 (en, zh-Hans, zh-Hant)
│   ├── pwa/                      # Service Worker 注册、安装状态检测与更新提示
│   ├── shared/                   # 客户端与 Worker 共享的 ChKSz 校验、匹配与版本签名逻辑
│   ├── stores/                   # 工作台全局偏好设置状态库
│   ├── styles/                   # Liquid Glass CSS 设计令牌 (tokens.css)
│   ├── test/                     # 前端单元测试、归属声明校验、运行时契约与 Vite 配置测试
│   ├── types/                    # TypeScript 环境类型声明
│   └── utils/                    # 安全本地存储封装 (safeStorage.ts)
├── tests/fixtures/               # 用于视频校验测试的微型合成纯色 MP4 与海报固件
├── workers/
│   ├── account/                  # 用户偏好同步路由处理器
│   ├── admin/                    # 管理员权限校验与后台 API 路由
│   ├── auth/                     # Google、GitHub 与 LINUX DO OAuth/OIDC 认证流与会话签名
│   ├── backgrounds/              # R2 背景媒体管理与 MP4 码流规格校验路由
│   ├── catalogue/                # D1 曲库暂存、差异比对、发布与 Google Sheets 导入
│   ├── focus/                    # 专注记录云同步路由
│   ├── library/                  # 个人曲库云同步路由
│   ├── providers/                # 服务端音源配置、SSRF 防护、媒体代理与解析路由
│   ├── test/                     # 基于 Miniflare 的 Worker + D1 安全与集成测试套件
│   ├── index.ts                  # Cloudflare Worker 主入口
│   ├── online-counter.js         # OnlineCounter Durable Object (WebSocket 在线人数与聊天)
│   └── presence.ts               # 在线状态路由辅助模块
├── BUILDING.txt                  # 本地开发与 Worker 环境搭建说明
├── LICENSE                       # GNU 通用公共许可证 v3.0 (GPL-3.0)
├── NOTICE                        # 源码来源、修改记录与版权声明
└── wrangler.toml                 # 本地 Cloudflare Workers、D1、R2 与 Durable Objects 配置
```

<a id="credits"></a>
<a id="zh-cn-credits"></a>

## 🙏 致谢 (Credits)

- https://github.com/lladlam/MeloX-Android
- https://github.com/iyinchao/liquid-glass-studio
- https://github.com/shshouse/StudyWithMiku

<a id="links"></a>
<a id="zh-cn-links"></a>

## 🔗 友链 (Links)

- [LINUX DO](https://linux.do/)

<a id="license"></a>
<a id="zh-cn-license"></a>

## 📄 开源协议与归属声明

本项目实现基线衍生自 [StudyWithMiku](https://github.com/shshouse/StudyWithMiku) 的提交版本 [`7b094632d08a6599a1b334e6c6af41dc10ea6495`](https://github.com/shshouse/StudyWithMiku/tree/7b094632d08a6599a1b334e6c6af41dc10ea6495)。Study with HOYO-MiX 基于 **GPL-3.0** 许可证开源；详见 [LICENSE](LICENSE)、[NOTICE](https://github.com/NullOkami47/study-with-hoyomix/blob/main/NOTICE) 与[第三方开源声明](docs/THIRD_PARTY_NOTICES.md)。

后 MVP 阶段的 LLM 曲目分类系统已从 MVP 计划中独立拆分。在独立完成来源验证与登记之前，本仓库不包含任何上游媒体资源。
