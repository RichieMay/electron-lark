'use strict';

// ============================================================================
// electron-lark 主进程（单文件分层，自上而下依赖单向；页面 hook 见 preload.js）
//
//   1. 常量           —— 不变的配置项
//   2. 运行时状态      —— 全部可变状态集中声明，禁止散落
//   3. 配置读写        —— config.json 落 userData（全应用唯一读写入口）
//   4. 通用工具        —— 登录页判断、窗口尺寸应用等基础函数
//   5. 会话初始化      —— UA / 权限 / 代理 / 下载（创建窗口前调用）
//   6. 主窗口          —— 创建、登录态尺寸切换、新窗口外链分发、图片独立查看窗口
//   7. 未读角标轮询    —— 角标 → 托盘闪烁 + 兜底通知
//   8. 系统通知        —— 主进程弹通知 + 页面 toast
//   9. 托盘            —— 图标、菜单、闪烁
//  10. 设置窗口        —— 单例
//  11. IPC             —— 全部频道收口在这里
//  12. App 生命周期    —— 入口编排，只做装配，不写具体逻辑
// ============================================================================

const appConf = require("./configuration")
const updateChecker = require('./updateChecker')

const electron = require('electron')
const fs = require('fs')
const path = require('path')

const app = electron.app;
const shell = electron.shell;
const Menu = electron.Menu;
const ipcMain = electron.ipcMain;
const Notification = electron.Notification;
const BrowserWindow = electron.BrowserWindow;
const globalShortcut = electron.globalShortcut;

// ============================ 1. 常量 ============================

// 用当前 Chromium 真实版本号生成 UA，只隐藏 Electron 痕迹
// 硬编码旧版 Chrome UA 会导致飞书文件预览判定浏览器过旧，提示"不支持查看"
const APP_USER_AGENT = (() => {
    const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
        : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
})();

// 窗口尺寸跟随登录状态：登录页保持默认小尺寸，登录成功自动切换为大尺寸
// 用户在登录期间调整的尺寸只在该次会话内自然保持，登出/重新登录后重置为默认
const LOGIN_WINDOW_SIZE = { width: 900, height: 800 };
const APP_WINDOW_SIZE = { width: 1450, height: 800 };

const DEFAULT_START_PAGE = 'https://feishu.cn/messenger/';

// Windows 通知 AUMID：须与 NSIS 快捷方式写入的 appId 一致，
// 否则设置里的通知开关管不到本进程发出的 toast
const APP_AUMID = 'com.richiemay.electron-lark';

// ============================ 2. 运行时状态 ============================

// 全部可变状态集中在此；各分区函数只读写这里，互相不持有私有引用
const S = {
    mainWindow: null,
    mainWebContents: null,   // 主窗口 webContents 快捷引用（可为 null）
    settingsWindow: null,    // 设置窗口（单例）
    imageWindows: new Set(), // 聊天图片独立查看窗口（防 GC 持有，关窗自动移除）
    imageWindowByKey: new Map(), // originKey → 活着的查看窗口（同图重复点 → 聚焦）
    tray: null,
    onFocus: false,          // 是否有应用窗口处于焦点
    isQuitting: false,       // 真正退出中（此时不再拦截主窗口 close）

    // 未读角标轮询状态
    badgePollTimer: null,
    lastUnreadBadgeCount: 0,
    badgeBaselineReady: false,

    // 托盘闪烁状态
    blingTimer: null,
    blingCount: 0,
    bling: false,

    lastHookNotifyTime: 0,   // 页面 hook 通知最近触发时间（兜底通知去重用）

    // webRequest 捕获的媒体流地址（最近在前，仅内存环形缓冲），
    // "保存视频"时若 <video> 上拿不到直链（blob:/MSE）从这里兜底
    mediaUrls: [],

    videoSaving: false,       // "保存视频"进行中（防连点重复下载）

    activeNotifications: new Set(), // 存活中的系统通知（防 GC 导致 toast 丢失/事件失效）
};

const dock32Icon = electron.nativeImage.createFromPath(appConf.dock32)
const dock32EmptyIcon = electron.nativeImage.createFromPath(appConf.dock32Empty)

// 主窗口是否存活（所有访问 mainWindow 的地方先过这个门）
function mainAlive() {
    return S.mainWindow != null && !S.mainWindow.isDestroyed()
}

// ============================ 3. 配置读写 ============================

// 关键修复：旧实现用相对路径 'config.json' 读写，实际解析到 process.cwd()。
// 打包安装后 cwd 是安装目录（Program Files，不可写），设置保存静默失败。
// 现在一律落在 userData（可写、随用户数据管理、卸载脚本可清理）。
function configPath() {
    return path.join(app.getPath('userData'), 'config.json')
}

// 默认配置：读取时与文件内容合并，保证新增字段有默认值、缺字段不 undefined
function defaultConfig() {
    return {
        startPageLink: null,   // 启动页地址，空则用默认飞书
        larkOpenLink: null,    // 需在应用内打开的链接（每行一个）
        showWarterMark: false, // 是否显示飞书页面水印
        proxyMode: 'system',   // 代理模式: system/pac/fixed/direct
        proxyPacUrl: null,     // PAC 脚本地址
        proxyServer: null,     // 固定代理服务器地址
    }
}

function loadConfig() {
    try {
        return Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(configPath(), 'utf-8')))
    } catch (e) {
        // 首次启动无配置文件属正常；损坏则回写默认值重建
        saveConfig(defaultConfig())
        return defaultConfig()
    }
}

function saveConfig(config) {
    try {
        fs.writeFileSync(configPath(), JSON.stringify(config, null, "  "))
        console.log("配置已保存: " + configPath())
        return true
    } catch (e) {
        console.error("配置保存失败:", e.message)
        return false
    }
}

// 一次性迁移：把旧版本遗留在工作目录的 config.json 带入 userData
function migrateLegacyConfig() {
    const legacy = path.join(process.cwd(), 'config.json')
    try {
        if (fs.existsSync(legacy) && !fs.existsSync(configPath())) {
            fs.copyFileSync(legacy, configPath())
            console.log("已迁移旧配置到 userData")
        }
    } catch (e) {
        console.log("旧配置迁移跳过:", e.message)
    }
}

// ============================ 4. 通用工具 ============================

// 未登录时飞书会重定向到 accounts 子域或 /login 路径
function isLoginUrl(url) {
    if (typeof url !== 'string' || url === '') return false;
    try {
        const u = new URL(url);
        return u.hostname.startsWith('accounts.') || u.pathname.includes('/login');
    } catch (e) {
        return url.toLowerCase().includes('/login');
    }
}

// 应用目标尺寸并居中到窗口当前所在的屏幕（小屏时按工作区封顶）
function applyWindowSize(win, size) {
    if (win == null || win.isDestroyed()) return;
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    const workArea = electron.screen.getDisplayMatching(win.getBounds()).workArea;
    const width = Math.min(size.width, workArea.width);
    const height = Math.min(size.height, workArea.height);
    win.setBounds({
        x: workArea.x + Math.floor((workArea.width - width) / 2),
        y: workArea.y + Math.floor((workArea.height - height) / 2),
        width: width,
        height: height,
    });
}

// ============================ 5. 会话初始化 ============================

/**
 * 初始化默认会话：UA / 通知权限 / 代理 / 下载。
 * 必须在创建主窗口之前调用，保证首个页面加载即按配置走
 */
function initSession(config) {
    const ses = electron.session.defaultSession

    // 下载请求由 session 发起，需与页面一致使用新 UA，避免飞书服务端校验失败
    ses.setUserAgent(APP_USER_AGENT)

    // 新版 Chromium 的通知权限模型要求显式授权，不设置的话
    // 飞书页面的 Notification 权限会被拒绝，消息通知静默失效
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
        // notifications: 页面通知（消息提醒）；fullscreen: 文件预览/视频全屏
        callback(permission === 'notifications' || permission === 'fullscreen')
    })

    initProxy(ses, config)
    initMediaCapture(ses)
    initDownload(ses)
}

/**
 * 记录最近的媒体流请求地址（内存环形缓冲，仅飞书域名，不拦截请求）：
 * "保存视频"时若 <video> 上拿不到 https 直链（blob:/MSE），从这里兜底。
 * 须用 onCompleted（单参数监听器，纯旁路）——onBeforeRequest 是阻塞式
 * API，漏调 callback 会把飞书全部请求挂死（白屏）。
 */
function initMediaCapture(ses) {
    const MEDIA_URL_RE = /\.mp4|video|media|stream/i
    ses.webRequest.onCompleted(
        { urls: [
            '*://*.feishu.cn/*', '*://feishu.cn/*',
            '*://*.feishucdn.com/*',
            '*://*.larksuite.com/*', '*://larksuite.com/*',
            '*://*.larksuitencdn.com/*',
        ] },
        (details) => {
            const t = details.resourceType
            if (t === 'media'
                || ((t === 'xhr' || t === 'fetch') && MEDIA_URL_RE.test(details.url))) {
                S.mediaUrls.unshift(details.url)
                if (S.mediaUrls.length > 50) S.mediaUrls.length = 50
            }
        }
    )
}

/**
 * 按用户配置应用网络代理（config 的 proxyMode/proxyPacUrl/proxyServer）
 *   system: 跟随系统代理（默认，不设置即为此行为）
 *   pac:    使用 PAC 自动配置脚本
 *   fixed:  固定代理服务器（http/https/socks4/socks5）
 *   direct: 所有连接直连
 */
function initProxy(ses, config) {
    if (config.proxyMode === 'pac') {
        const pacUrl = (config.proxyPacUrl || "").trim()
        if (pacUrl !== "") {
            console.log("使用 PAC 代理: " + pacUrl)
            ses.setProxy({ pacUrl: pacUrl })
            return
        }
        console.log("PAC 模式但未配置脚本地址，回退系统代理")
    }

    if (config.proxyMode === 'fixed') {
        const server = (config.proxyServer || "").trim()
        if (server !== "") {
            console.log("使用固定代理: " + server)
            ses.setProxy({ proxyRules: server })
            return
        }
        console.log("fixed 模式但未配置服务器地址，回退系统代理")
    }

    if (config.proxyMode === 'direct') {
        console.log("所有连接直连")
        ses.setProxy({ mode: 'direct' })
        return
    }

    // system 或无效配置：跟随系统代理
    ses.setProxy({ mode: 'system' })
}

/**
 * 应用内文件下载处理：
 * 飞书页面触发的下载自动保存到系统"下载"目录（同名文件自动加序号，不覆盖），
 * 下载完成后系统通知，点击通知打开文件所在文件夹
 */
function initDownload(ses) {
    ses.on('will-download', (event, item) => {
        const downloadDir = app.getPath('downloads')
        const filename = item.getFilename() || 'download'
        let savePath = path.join(downloadDir, filename)

        // 同名文件自动加 " (n)" 后缀，避免覆盖已有文件
        if (fs.existsSync(savePath)) {
            const ext = path.extname(filename)
            const base = filename.slice(0, filename.length - ext.length)
            let n = 1
            while (fs.existsSync(path.join(downloadDir, `${base} (${n})${ext}`))) {
                n++
            }
            savePath = path.join(downloadDir, `${base} (${n})${ext}`)
        }
        item.setSavePath(savePath)
        console.log("download save path: " + savePath)

        item.once('done', (e, state) => {
            if (state === 'completed') {
                showSystemNotify({
                    title: "下载完成",
                    body: filename,
                    onClick: function () { shell.showItemInFolder(savePath) },
                })
            } else {
                showSystemNotify({
                    title: "下载失败",
                    body: filename + " (" + state + ")",
                })
            }
        })
    })
}

/**
 * "保存到本地"（视频消息右键菜单注入项）：
 * 官方下载被服务端权限拦截（视频可播放），这里用默认会话（自带 cookie +
 * 页面同款 UA）重拉播放器使用的流地址。落盘/通知与官方下载一致：
 * 下载目录、同名加序号、完成通知点击打开所在文件夹。
 *   src:     preload 取到的流地址（https 直链或空，blob: 主进程不可用）
 *   pageUrl: 来源页面地址，作 referrer 防签名校验失败
 *   name:    preload 从消息 fiber 读到的原始文件名（content.mediaContent.name），
 *            探测不到响应文件名时兜底
 */
async function saveVideoAs(src, pageUrl, name) {
    if (S.videoSaving) return   // 防连点重复下载
    S.videoSaving = true
    try {
        await doSaveVideoAs(src, pageUrl, name)
    } catch (e) {
        console.log("save-video 异常: " + (e && e.message))
    } finally {
        S.videoSaving = false
    }
}

async function doSaveVideoAs(src, pageUrl, name) {
    const ses = electron.session.defaultSession

    // blob: 主进程解析不了，回退抓包缓冲里最近一条 https 直链
    let target = ''
    if (typeof src === 'string' && src.startsWith('https')) target = src
    if (target === '') {
        const hit = S.mediaUrls.find(u => u.startsWith('https'))
        if (hit) target = hit
    }
    if (target === '') {
        showSystemNotify({ title: "无法保存视频", body: "没有可用的视频流地址，请重新播放后重试" })
        return
    }

    // 文件名优先级：响应 Content-Disposition > URL 尾段 > preload 从消息
    // fiber 读到的原始名 > 时间戳兜底。Range:0 只为读响应头（CDN 常见对
    // 探测请求回 400，读不到不影响下载本体）
    let filename = ''
    try {
        const head = await ses.fetch(target, {
            headers: { 'Range': 'bytes=0-0' },
            referrer: pageUrl,
        })
        const cd = head.headers.get('content-disposition') || ''
        const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
        if (m) filename = decodeURIComponent(m[1])
        if (!filename) {
            const last = new URL(target).pathname.split('/').filter(Boolean).pop() || ''
            if (/\.[a-z0-9]{2,5}$/i.test(last)) filename = decodeURIComponent(last)
        }
        try { head.body && head.body.cancel() } catch (_) { }
    } catch (e) {
        console.log('elk 探测视频文件名失败: ' + e.message)
    }
    if (!filename && typeof name === 'string' && /\.[a-z0-9]{2,5}$/i.test(name)) {
        filename = name.replace(/[\\/:*?"<>|]/g, '_')   // 去掉跨平台非法字符
    }
    if (!filename) filename = 'video-' + Date.now() + '.mp4'

    const saveDir = app.getPath('downloads')
    let savePath = path.join(saveDir, filename)
    {
        const ext = path.extname(filename)
        const base = filename.slice(0, filename.length - ext.length)
        let n = 1
        while (fs.existsSync(savePath)) {
            savePath = path.join(saveDir, base + ' (' + n + ')' + ext)
            n++
        }
    }
    console.log('elk save-video 落盘: ' + savePath)

    const fail = function (msg) {
        console.log('elk save-video 失败: ' + msg)
        showSystemNotify({ title: "下载失败", body: filename + " (" + msg + ")" })
        try { fs.unlinkSync(savePath) } catch (_) { }
    }
    try {
        const resp = await ses.fetch(target, { referrer: pageUrl })
        if (!resp.ok) { fail("HTTP " + resp.status); return }
        // WHATWG 流 → fs 流搬运（带背压），大视频不整载内存
        const reader = resp.body.getReader()
        const out = fs.createWriteStream(savePath)
        const outClosed = new Promise(function (resolve, reject) {
            out.on('error', reject)
            out.on('close', function () { resolve() })
        })
        try {
            for (; ;) {
                const { done, value } = await reader.read()
                if (done) break
                if (!out.write(value)) {
                    await new Promise(function (resolve) { out.once('drain', resolve) })
                }
            }
            out.end()
            await outClosed
        } finally {
            try { out.destroy() } catch (_) { }
        }
        showSystemNotify({
            title: "下载完成",
            body: filename,
            onClick: function () { shell.showItemInFolder(savePath) },
        })
    } catch (e) {
        fail(e.message)
    }
}

/**
 * 图片消息右键"保存到本地"：preload 抓到的原图 dataURL 直接落盘。
 * 落盘/通知与视频保存、官方下载一致：下载目录、同名加序号、完成通知
 * 点击打开所在文件夹
 */
function saveImageAs(dataUrl, name, key) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return
    const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|bmp|avif);base64,(.*)$/s)
    if (!m) { console.log('save-image: 未知图片格式'); return }
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    // 命名链：消息原文件名（fiber content.name，image 消息才有）→ 图片
    // key 尾段（post 内嵌图消息数据里无文件名，key 对同图稳定可辨识）
    // → 时间戳。扩展名由 dataURL MIME 定，key 尾段不含扩展名故补 ext
    const clean = (s) => s.trim().replace(/\.(png|jpe?g|webp|gif|bmp|avif)$/i, '').replace(/[\\/:*?"<>|]/g, '_')
    const rawName = (typeof name === 'string' && name.trim()) ? clean(name) : ''
    const rawKey = (typeof key === 'string' && key.trim()) ? clean(key.split('_').pop()) : ''
    const base = rawName || rawKey || 'image-' + Date.now()
    const filename = base + '.' + ext
    const saveDir = app.getPath('downloads')
    let savePath = path.join(saveDir, filename)
    {
        let n = 1
        while (fs.existsSync(savePath)) {
            savePath = path.join(saveDir, base + ' (' + n + ').' + ext)
            n++
        }
    }
    try {
        fs.writeFileSync(savePath, Buffer.from(m[2], 'base64'))
        console.log('elk save-image 落盘: ' + savePath)
        showSystemNotify({
            title: "下载完成",
            body: filename,
            onClick: function () { shell.showItemInFolder(savePath) },
        })
    } catch (e) {
        console.log('elk save-image 失败: ' + e.message)
        showSystemNotify({ title: "下载失败", body: filename })
    }
}

// ============================ 6. 主窗口（主窗口 + 图片查看窗口） ============================

function createMainWindow(config) {
    const win = new BrowserWindow({
        width: LOGIN_WINDOW_SIZE.width,
        height: LOGIN_WINDOW_SIZE.height,
        minWidth: 800,
        minHeight: 600,
        resizable: true,
        webPreferences: {
            // 页面 hook（通知转发 + 图片点击拦截）放在 preload，
            // 每个新文档自动执行，时序确定（详见 preload.js 头注释）
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: false,
            // 常驻 IM：隐藏到托盘后禁止后台节流，否则角标停更、消息延迟处理
            backgroundThrottling: false,
        },
        icon: appConf.icon128
    })
    S.mainWindow = win
    S.mainWebContents = win.webContents

    // 登录状态驱动的窗口尺寸切换：
    // 进入登录页 → 小尺寸；离开登录页(登录成功) → 大尺寸。
    // 用户调整过的尺寸只在登录后的会话内自然保持，重新登录时重置为默认
    let windowSizeStage = 'login';
    win.webContents.on('did-navigate', (event, url) => {
        if (isLoginUrl(url)) {
            if (windowSizeStage !== 'login') {
                windowSizeStage = 'login';
                applyWindowSize(win, LOGIN_WINDOW_SIZE);
            }
        } else {
            if (windowSizeStage !== 'app') {
                windowSizeStage = 'app';
                applyWindowSize(win, APP_WINDOW_SIZE);
            }
        }
    });

    // 默认加载网页版飞书，可由配置的 startPageLink 覆盖
    let loadUrl = DEFAULT_START_PAGE;
    if (config.startPageLink != null && ("" + config.startPageLink).trim() !== "") {
        loadUrl = config.startPageLink
    }
    console.log("load main page: " + loadUrl)
    win.loadURL(loadUrl, { userAgent: APP_USER_AGENT })

    win.on('closed', function () {
        if (S.mainWindow === win) {
            S.mainWindow = null
            S.mainWebContents = null
        }
    })

    // 点 X 隐藏到托盘而非退出；真正退出（托盘退出/关机）放行
    win.on('close', (event) => {
        if (S.isQuitting) return
        win.hide()
        win.setSkipTaskbar(true)
        event.preventDefault()
    })

    const webContents = win.webContents

    // 开发者工具开/关时（含用户直接 X 掉 DevTools 窗口）推送状态给设置页，
    // 设置页开关随之联动，不再只在切页签时拉取一次
    webContents.on('devtools-open-state', (event, isOpen) => {
        console.log("devtools open state: " + isOpen)
        if (S.settingsWindow != null && !S.settingsWindow.isDestroyed()) {
            S.settingsWindow.webContents.send('devtools-state-changed', isOpen)
        }
    })

    // 页面 DOM 就绪后（重）启动轮询与更新检查。
    // 不用 did-finish-load：它要求页面完全加载(complete)，而新版飞书有
    // 永不结束的资源加载（SSE 长连接等），事件可能永远不触发
    webContents.on('dom-ready', function () {
        startBadgePoll(!!config.showWarterMark)
        // 静默更新检查：结果统一走 showUpdateResultToast（系统通知，失败落 toast）
        updateChecker.checkInAppStart(showUpdateResultToast);
        updateChecker.startDailyCheck(showUpdateResultToast);
    })

    // 飞书域名默认留在应用内打开：文件/预览链接若转交系统浏览器会丢失登录态，
    // 报 session key not found；其余链接交给系统默认浏览器
    let electronUrl = ['feishu.cn', 'larksuite.com']
    if (config.larkOpenLink != null && ("" + config.larkOpenLink).trim() !== "") {
        electronUrl = electronUrl.concat(("" + config.larkOpenLink).split("\n"))
    }

    // Electron 22 起移除了 new-window 事件，改用 setWindowOpenHandler
    webContents.setWindowOpenHandler(({ url }) => {
        console.log("open url " + url)

        const openInElectron = electronUrl.some(
            item => item.trim() !== "" && url.indexOf(item) >= 0)
        if (openInElectron) {
            console.log("open url electron")
        } else if (url.startsWith("http")) {
            shell.openExternal(url)
        }

        return {
            action: openInElectron ? 'allow' : 'deny',
            overrideBrowserWindowOptions: {
                width: 1200,
                height: 600,
                show: false,
            },
        }
    })

    // 应用内新窗口（如文件预览页）加载完成后再显示，并统一设置 UA
    webContents.on('did-create-window', (childWindow) => {
        childWindow.webContents.setUserAgent(APP_USER_AGENT)
        childWindow.once('ready-to-show', () => childWindow.show())
    })

    return win
}

/**
 * 聊天图片独立查看窗口（替代飞书页面内全屏查看器）。
 * 图片包一层 HTML 由页面脚本接管布局（Chromium 原生图片文档的适应尺寸
 * 在加载时固定，不跟随窗口变化）：
 * - 居中自适应窗口大小
 * - Shift/Ctrl+滚轮以鼠标位置为中心缩放（0.1~5 倍），普通滚轮平移
 * - 双击切换"适应窗口 / 像素原大"，右上角短暂显示缩放百分比
 * src 为 preload 转换的原图 dataURL。key 为消息 originKey（同图恒定）：
 * 同图重复点击不重复开窗、聚焦已有窗口；关窗解绑，之后再点可重开
 */
function openImageWindow(src, key) {
    if (typeof src !== 'string' || !src.startsWith('data:')) return

    // 同图已有活窗 → 提到前台即可
    if (key && S.imageWindowByKey.has(key)) {
        const exist = S.imageWindowByKey.get(key)
        if (exist && !exist.isDestroyed()) {
            if (exist.isMinimized()) exist.restore()
            exist.focus()
            return exist
        }
        S.imageWindowByKey.delete(key)
    }

    // 图片查看页脚本：接管布局后 max-width/max-height 由 JS 显式尺寸取代，
    // 缩放锚点取鼠标位置（未放大时滚动量为 0，公式自然退化为居中缩放）
    const pageScript = "var stage=document.getElementById('stage'),view=document.getElementById('view'),tip=document.getElementById('tip');"
        + "var z=1,fit=1,ready=false,tipTimer=null;"
        + "function showTip(t){tip.textContent=t;tip.style.opacity=1;"
        + " clearTimeout(tipTimer);tipTimer=setTimeout(function(){tip.style.opacity=0},900);}"
        + "function apply(){"
        + " if(!ready)return;"
        + " fit=Math.min(stage.clientWidth/view.naturalWidth,stage.clientHeight/view.naturalHeight,1);"
        + " if(!(fit>0))fit=1;"
        + " view.style.width=Math.round(view.naturalWidth*fit*z)+'px';"
        + " view.style.height='auto';"
        + " showTip(Math.round(fit*z*100)+'%');"
        + "}"
        + "function zoomAt(x,y,f){"
        + " if(!ready)return;"
        + " var ow=view.width,oh=view.height;"
        + " z=Math.min(5,Math.max(0.1,z*f));"
        + " apply();"
        + " if(ow>0&&oh>0){"
        + "  stage.scrollLeft=(stage.scrollLeft+x)*(view.width/ow)-x;"
        + "  stage.scrollTop=(stage.scrollTop+y)*(view.height/oh)-y;"
        + " }"
        + "}"
        + "view.addEventListener('load',function(){"
        + " ready=view.naturalWidth>0&&view.naturalHeight>0;"
        + " view.style.maxWidth='none';view.style.maxHeight='none';"
        + " if(!ready){showTip('图片加载失败');return}"
        + " apply();"
        + "});"
        + "view.addEventListener('error',function(){showTip('图片加载失败')});"
        + "window.addEventListener('resize',apply);"
        + "stage.addEventListener('wheel',function(e){"
        + " if(e.shiftKey||e.ctrlKey||e.metaKey){e.preventDefault();zoomAt(e.clientX,e.clientY,e.deltaY<0?1.25:0.8);}"
        + "},{passive:false});"
        + "view.addEventListener('dblclick',function(){"
        + " var t=fit<1?1/fit:2;"
        + " z=(z===t?1:t);"
        + " apply();"
        + "});"

    // src 拼进 HTML 属性（防御性转义，dataURL 内不会出现这两个字符）
    const srcAttr = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>图片查看</title><style>'
        + 'html,body{margin:0;height:100%;background:#1e1e1e;overflow:hidden}'
        + '#stage{height:100%;overflow:auto;display:flex}'
        // margin:auto 居中：放大溢出时内容不会被裁掉（justify-content:center 会）
        + '#view{margin:auto;max-width:100%;max-height:100%;-webkit-user-select:none}'
        + '#tip{position:fixed;top:8px;right:10px;font:12px/1.8 monospace;color:#ddd;'
        + 'background:rgba(0,0,0,.5);padding:0 8px;border-radius:9px;'
        + 'opacity:0;transition:opacity .4s;pointer-events:none}'
        + '</style></head><body>'
        + '<div id="stage"><img id="view" draggable="false" src="' + srcAttr + '"></div>'
        + '<div id="tip"></div>'
        + '<script>' + pageScript + '</script>'
        + '</body></html>'

    const win = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 200,
        minHeight: 150,
        autoHideMenuBar: true,
        backgroundColor: '#1e1e1e',
        webPreferences: {
            session: electron.session.defaultSession,
        },
    })
    S.imageWindows.add(win)
    if (key) S.imageWindowByKey.set(key, win)
    win.on('closed', function () {
        S.imageWindows.delete(win)
        if (key && S.imageWindowByKey.get(key) === win) S.imageWindowByKey.delete(key)
    })
    // 右键菜单只留"复制图片"（主进程从 dataURL 解码 PNG 写剪贴板；
    // copyImageAt 依赖渲染进程按坐标取图、大 dataURL 下不稳）。Electron 45
    // 剪贴板为 W3C 风格：writeImage 已删，须 ClipboardItem+Blob
    win.webContents.on('context-menu', function (_e, params) {
        if (params.mediaType !== 'image') return
        electron.Menu.buildFromTemplate([{
            label: '复制图片',
            click: function () {
                const img = electron.nativeImage.createFromDataURL(src)
                if (img.isEmpty()) {
                    win.webContents.executeJavaScript('showTip("复制失败")').catch(function () { })
                    return
                }
                const blob = new Blob([img.toPNG()], { type: 'image/png' })
                electron.clipboard.write([new electron.ClipboardItem({ 'image/png': blob })])
                    .then(function () {
                        win.webContents.executeJavaScript('showTip("已复制")').catch(function () { })
                    })
                    .catch(function () {
                        win.webContents.executeJavaScript('showTip("复制失败")').catch(function () { })
                    })
            },
        }]).popup({ window: win })
    })

    // 大图 base64 后可能超 data: URL 顶层导航 2MB 上限（Chromium 限制，
    // 超限 loadURL 拒绝 → 窗口空闪退）。统一走临时 HTML 文件：文件名用
    // pid+key 哈希（同图同文件，天然防堆积；无 key 用内容哈希），加载
    // 完成（did-finish-load，文档已在渲染进程内存）即删，不等关窗
    const tmpDir = path.join(app.getPath('temp'), 'elk-imageview-' + process.pid)
    let tmpFile = null
    try {
        fs.mkdirSync(tmpDir, { recursive: true })
        let name = key || src
        if (name.length > 64) {
            name = require('crypto').createHash('md5').update(name).digest('hex')
        }
        tmpFile = path.join(tmpDir, 'img-' + name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) + '.html')
        fs.writeFileSync(tmpFile, html)
        const file = tmpFile
        const cleanup = () => { try { fs.rmSync(file, { force: true }) } catch (e) { } }
        win.once('closed', cleanup)   // 加载失败/未完成就关窗的兜底
        win.loadFile(file)
            .then(() => {
                cleanup()
                win.removeListener('closed', cleanup)
            })
            .catch(function (e) {
                console.log("图片窗口加载失败: " + e.message)
                cleanup()
                win.close()
            })
    } catch (e) {
        console.log("图片窗口临时文件失败: " + e.message)
        if (tmpFile) { try { fs.rmSync(tmpFile, { force: true }) } catch (e2) { } }
        win.close()
    }
    return win
}

// ============================ 7. 未读角标轮询 ============================

/**
 * 启动未读角标轮询（每 1.5s，先清旧定时器避免页面重载后叠加）：
 * - 有未读 → 托盘图标闪烁；无未读 → 停止闪烁
 * - 未读数增加 → 兜底弹系统通知（页面 hook 可能被新版飞书绕过）
 * - 未开启水印时顺带移除飞书页面水印
 */
function startBadgePoll(showWarterMark) {
    if (S.badgePollTimer != null) clearInterval(S.badgePollTimer)
    S.badgePollTimer = setInterval(() => {
        if (!mainAlive()) return
        const webContents = S.mainWebContents

        // 未读角标检测，三重策略（旧版 class → 标题未读数 → 通用 badge 元素），
        // 飞书前端改版只换 class 名时不至于全部失配导致托盘永不闪烁
        webContents.executeJavaScript(`
            (function(){
                var legacy = document.getElementsByClassName('larkc-badge-count circle larkc-badge-normal').length;
                if(legacy > 0) return legacy;
                var m = (document.title || '').match(/\\((\\d+)\\)/);
                if(m) return parseInt(m[1]);
                // 兜底：可见的 badge 元素且内容为正数（含 99+）即算未读；
                // 隐藏元素 textContent 仍有值，须用 offsetParent 过滤
                var badges = document.querySelectorAll('[class*="badge-count"], [class*="badgeCount"]');
                var n = 0;
                for(var i=0;i<badges.length;i++){
                    if(badges[i].offsetParent === null) continue;
                    var t = (badges[i].textContent || '').trim();
                    var v = parseInt(t);
                    if(!isNaN(v) && v > 0) n++;
                }
                return n;
            })()`)
            .then(function (result) {
                const unread = parseInt(result) || 0
                if (unread > 0) {
                    startTrayBling();
                } else {
                    stopTrayBling();
                }
                maybeNotifyNewMessage(unread)
            }).catch(function () {
                // 页面导航/销毁瞬间的轮询失败可忽略
            })
        if (!showWarterMark) {
            webContents.executeJavaScript(`if(document.getElementsByClassName('lark-water-mark-main').length > 0) document.getElementsByClassName('lark-water-mark-main')[0].remove()`)
        }
    }, 1500)
}

/**
 * 新消息兜底通知（与页面 hook 通知互补，不依赖飞书前端实现方式）：
 * - 首轮只建立基线不弹（否则启动时已有未读会立即轰炸）
 * - 页面 hook 通知刚触发过（60s 内）则跳过，避免同一条消息弹两次
 * - 用户正聚焦飞书窗口时不弹（与托盘闪烁的判断一致）
 */
function maybeNotifyNewMessage(currentUnread) {
    if (!S.badgeBaselineReady) {
        S.badgeBaselineReady = true
        S.lastUnreadBadgeCount = currentUnread
        return
    }
    if (currentUnread > S.lastUnreadBadgeCount) {
        const watching = S.onFocus && mainAlive() && S.mainWindow.isVisible()
        if (!watching && Date.now() - S.lastHookNotifyTime > 60 * 1000) {
            showSystemNotify({
                title: "飞书新消息",
                body: "收到新消息，点击查看",
                onClick: function () { if (mainAlive()) S.mainWindow.show() },
            })
        }
    }
    S.lastUnreadBadgeCount = currentUnread
}

// ============================ 8. 系统通知 ============================

/**
 * 主进程弹系统通知的统一入口。
 * opts: { title, body, onClick, toastLink }
 * 系统通知不可用（如 WSL 无通知服务）时退回主窗口右下角 toast；
 * toastLink 可选，指定后 toast 内该链接可点（经 open-external 打开）
 */
function showSystemNotify(opts) {
    if (!Notification.isSupported()) {
        showPageToast((opts.title || '') + (opts.body ? '\n' + opts.body : ''), opts.toastLink)
        return null
    }

    const n = new Notification({
        title: opts.title,
        subtitle: opts.title,
        body: opts.body,
        icon: dock32Icon,
    })

    // 持有通知对象直到展示结束，防止 GC 导致 Windows toast 不显示/事件丢失
    S.activeNotifications.add(n)
    n.once('close', function () { S.activeNotifications.delete(n) })
    n.once('failed', function () { S.activeNotifications.delete(n) })

    if (opts.onClick) {
        n.addListener('click', opts.onClick)
    }

    n.show()
    return n
}

/**
 * 在主窗口(飞书页面)右下角弹纯文本 toast（更新结果等）。
 * 经 preload 的 IPC 通道渲染（executeJavaScript 在飞书 SSE 场景下
 * 时序不可靠，见 preload 头注释）；5 秒后自动消失。
 * linkUrl 可选：指定后 toast 末尾附可点的"前往下载"，点击经
 * open-external 用系统浏览器打开
 */
function showPageToast(text, linkUrl) {
    if (!mainAlive() || S.mainWebContents == null) return
    S.mainWebContents.send('page-toast', text, linkUrl)
}

// 更新检查结果展示的唯一入口（手动检查与静默检查共用）：
// 统一走系统通知（与新消息通知同一链路），点击跳 Release 页；
// 系统通知不可用时 showSystemNotify 自行退回 toast（带可点"前往下载"）
function showUpdateResultToast(result) {
    if (result.type === 'newer') {
        const copy = updateChecker.newerVersionCopy(result.version)
        showSystemNotify({
            title: copy.title,
            body: copy.body,
            onClick: function () {
                shell.openExternal(updateChecker.RELEASE_PAGE_URL)
            },
            toastLink: updateChecker.RELEASE_PAGE_URL,
        })
    } else if (result.type === 'latest') {
        showSystemNotify({ title: "当前已是最新版本" })
    } else {
        showSystemNotify({ title: "检查更新失败", body: result.message })
    }
}

// 通知点击：显示主窗口并注入 js 打开对应的聊天框
// 参考 https://github.com/Ericwyn/electron-lark/commit/f8c4781fab5c6cd704aa2bba4be0d4d0cedcaab1#commitcomment-51571446
function openChatByChannelId(channelId) {
    if (!mainAlive()) return
    S.mainWindow.show()
    S.mainWebContents.executeJavaScript(`
        var doms = document.getElementsByTagName("div");
        for(let i =0;i<doms.length;i++){
            if(doms[i].getAttribute("data-feed-id") == '${channelId}') {
                doms[i].click();
                break;
            }
        }
    `).catch(function () {
        // 页面导航/销毁瞬间注入失败可忽略
    })
}

// ============================ 9. 托盘 ============================

function startTrayBling() {
    // 用户正看着主窗口时不闪烁
    if (S.onFocus && mainAlive() && S.mainWindow.isVisible()) {
        stopTrayBling()
        return
    }
    if (S.blingTimer != null) return

    S.bling = true
    S.blingTimer = setInterval(function () {
        S.blingCount++
        if (S.blingCount % 2 == 0) {
            S.tray.setImage(dock32EmptyIcon)
        } else {
            S.tray.setImage(dock32Icon)
        }
        // 避免 count 无限增大
        if (S.blingCount == 1000) S.blingCount = 0
    }, 500)
}

function stopTrayBling() {
    if (!S.bling) return
    if (S.blingTimer != null) {
        clearInterval(S.blingTimer)
        S.blingTimer = null
    }
    S.tray.setImage(dock32Icon)
    S.bling = false
}

function initTray() {
    const menu = Menu.buildFromTemplate([
        {
            label: '显示主界面',
            click: function () {
                if (mainAlive()) S.mainWindow.show()
            }
        },
        {
            label: '系统设置',
            click: function () { openSettingsWindow() }
        },
        { type: 'separator' },
        {
            label: '退出程序',
            click: function () {
                console.log("从 tray 退出")
                app.quit() // before-quit 置 isQuitting，主窗口 close 放行
            }
        },
    ])

    S.tray = new electron.Tray(dock32Icon)
    S.tray.setToolTip('Feishu')
    S.tray.setContextMenu(menu)

    // 单击：切换主窗口显示/隐藏，并停止闪烁
    S.tray.on('click', function () {
        stopTrayBling()
        if (!mainAlive()) return
        S.mainWindow.isVisible() ? S.mainWindow.hide() : S.mainWindow.show()
        S.mainWindow.isVisible() ? S.mainWindow.setSkipTaskbar(false) : S.mainWindow.setSkipTaskbar(true)
    })

    // 双击：仅显示
    S.tray.on('double-click', function () {
        if (mainAlive() && !S.mainWindow.isVisible()) S.mainWindow.show()
    })
}

// ============================ 10. 设置窗口 ============================

/**
 * 打开设置窗口（单例：已打开则置顶聚焦，不再重复开窗）
 * page 参数为设置页内的页签（如 about-info 直接打开"关于"页），可选
 */
function openSettingsWindow(page) {
    if (S.settingsWindow != null && !S.settingsWindow.isDestroyed()) {
        S.settingsWindow.show()
        S.settingsWindow.focus()
        // 页签请求（如 about-info）：调用页面内 showPage 切换（Vue 响应式），
        // 同步 hash 保持一致；无请求则保持当前页签不动
        if (page != null && page !== '') {
            S.settingsWindow.webContents.executeJavaScript(
                `if(location.hash !== '#${page}'){ location.hash = '#${page}'; }` +
                `if(typeof showPage === 'function'){ showPage(${JSON.stringify(page)}); }`
            ).catch(function () { /* 窗口销毁竞态可忽略 */ })
        }
        return
    }

    const win = new BrowserWindow({
        width: 700,
        height: 650,
        frame: false,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
    })
    S.settingsWindow = win
    win.setMenuBarVisibility(false)

    // 通过 hash 指定初始页签（如 #about-info 直接打开"关于"页）
    const hash = (page != null && page !== '') ? ('#' + page) : ''
    win.loadURL('file://' + __dirname + '/windows/views/settings.html' + hash)

    // 窗口关闭后清空引用，下次可重新打开
    win.on('closed', function () {
        if (S.settingsWindow === win) S.settingsWindow = null
    })
}

// ============================ 11. IPC ============================

function registerIpcHandlers() {
    // 页面通知 hook 转发来的消息（title 是聊天对象名，opt.body 是消息内容）
    ipcMain.on("notification", (event, msg) => {
        const args = JSON.parse(msg)
        // 记录 hook 通知时间，兜底角标通知据此去重
        S.lastHookNotifyTime = Date.now()
        showSystemNotify({
            title: args.title,
            body: args.opt && args.opt.body,
            onClick: function () { openChatByChannelId(args.opt && args.opt.channelId) },
        })
        event.returnValue = 'pong'
    })

    // 设置页：读取配置（页面不再直接 fs 读写，路径问题在主进程统一解决）
    ipcMain.on("get-config", (event) => {
        event.returnValue = loadConfig()
    })

    // 设置页：保存配置
    ipcMain.on("save-config", (event, config) => {
        event.returnValue = saveConfig(config)
    })

    // 设置页：应用版本号（关于页展示）
    ipcMain.on("get-app-version", (event) => {
        event.returnValue = app.getVersion()
    })

    // 设置页发起的检查更新请求
    // 结果仅在主窗口右下角 toast 展示（设置页只保留"正在检查更新"提示）
    ipcMain.on("check-update", (event) => {
        updateChecker.check(null, showUpdateResultToast)
        event.returnValue = 'ok'
    })

    // 设置页"调试模式"开关：打开/关闭主窗口开发者工具
    // 状态不持久化，以主窗口 webContents 的真实状态为准
    ipcMain.on("toggle-devtools", (event, open) => {
        if (mainAlive()) {
            if (open === true) {
                S.mainWebContents.openDevTools()
            } else {
                S.mainWebContents.closeDevTools()
            }
        }
        event.returnValue = 'ok'
    })

    // 设置页查询开发者工具当前状态（打开设置页/切到调试页签时拉取）
    ipcMain.on("query-devtools", (event) => {
        event.returnValue = mainAlive() && S.mainWebContents.isDevToolsOpened()
    })

    // 通用：用系统默认浏览器打开外链（如设置页"前往项目主页"）
    ipcMain.on("open-external", (event, url) => {
        if (typeof url === 'string' && url.startsWith('http')) {
            shell.openExternal(url)
        }
    })

    // 页面 hook：聊天图片点击 → 独立可缩放查看窗口（同图去重聚焦）
    ipcMain.on("open-image-window", (event, payload) => {
        const args = (payload && typeof payload === 'object') ? payload : { src: payload }
        openImageWindow(args.src, args.key)
    })

    // 页面 hook：图片消息右键"保存到本地" → 原图 dataURL 直接落盘
    ipcMain.on("save-image", (event, msg) => {
        try {
            const args = JSON.parse(msg)
            saveImageAs(args.src, args.name, args.key)
        } catch (e) {
            console.log("save-image 解析失败: " + e.message)
        }
    })

    // 页面 hook：视频消息右键"保存到本地" → 带登录态重拉流，按官方下载行为落盘
    ipcMain.on("save-video", (event, msg) => {
        try {
            const args = JSON.parse(msg)
            saveVideoAs(args.src, args.pageUrl, args.name)
        } catch (e) {
            console.log("save-video 解析失败: " + e.message)
        }
    })
}

// ============================ 12. App 生命周期 ============================

// ----- App 级初始化（须在 ready 前执行的部分）-----

if (process.mas) app.setName('飞书Feishu');

// Windows 通知依赖 AUMID，需与 electron-builder NSIS 快捷方式写入的 appId 一致，
// 否则打包后 Notification 全部静默不弹（消息提醒/更新提示/下载完成都会受影响）
if (process.platform === 'win32') {
    app.setAppUserModelId(APP_AUMID);
}

// userData 目录固定为 ElectronLark（与 NSIS 卸载脚本删除的目录一致）
app.setPath('userData', path.join(app.getPath('appData'), 'ElectronLark'));

// fixup High CPU Usage issue
// see https://github.com/electron/electron/issues/11908
app.disableHardwareAcceleration();

// 修复 Application Menu 上图标不显示（Ubuntu GNOME）
if (process.env.XDG_CURRENT_DESKTOP == 'ubuntu:GNOME') {
    process.env.XDG_CURRENT_DESKTOP = 'Unity';
}

// 单实例锁：重复启动（再点一次快捷方式）聚焦已有窗口，而不是开第二套
if (!app.requestSingleInstanceLock()) {
    app.quit()
} else {
    app.on('second-instance', function () {
        if (mainAlive()) {
            if (!S.mainWindow.isVisible()) S.mainWindow.show()
            S.mainWindow.focus()
        }
    })
}

// 托盘退出/关机 → 标记真正退出，主窗口 close 拦截放行
app.on('before-quit', function () {
    S.isQuitting = true
})

// 焦点状态跟踪（托盘闪烁/兜底通知据此判断用户是否正在看消息）
app.on('browser-window-blur', function () { S.onFocus = false })
app.on('browser-window-focus', function () { S.onFocus = true })

// 右键菜单：electron-context-menu 4.x 起为纯 ESM 包，
// 主进程(CommonJS)需用动态 import() 加载
import('electron-context-menu').then(contextMenu => {
    contextMenu.default({
        showInspectElement: false,
        showCopyImage: true,
        showCopyImageAddress: true,
        showSaveImageAs: true,
        labels: {
            copy: '复制',
            copyImage: '复制图片',
            copyImageAddress: '复制图片地址',
            saveImageAs: '图片另存为',
        },
        // 图片查看窗口有自己的"只留复制图片"菜单，全局菜单跳过它
        shouldShowMenu: (_event, params) => !params.pageURL.startsWith('file:'),
    });
}).catch(err => console.error("electron-context-menu 加载失败:", err));

// ----- ready：装配 -----

app.on('ready', function () {
    // 应用不显示菜单栏（所有入口集中到托盘菜单）
    // 需要开发者工具时可用快捷键 Ctrl+Shift+I 或设置页"调试模式"开关
    Menu.setApplicationMenu(null)

    // 旧版本配置遗留在工作目录的话，先迁入 userData
    migrateLegacyConfig()
    const config = loadConfig()

    // 会话初始化（UA/权限/代理/下载）须在建窗之前，保证首屏即按代理走
    initSession(config)

    initTray()
    registerIpcHandlers()
    createMainWindow(config)

    // 显示主窗口快捷键
    globalShortcut.register('alt+shift+m', () => {
        if (mainAlive()) S.mainWindow.show()
    })
})

app.on('window-all-closed', () => {
    // 主窗口 close 被拦截（隐藏到托盘）时不会到这里；
    // 能到这里说明所有窗口真的关了（正在退出）
    app.quit();
})

// macOS dock 图标点击（本应用主要发布 Windows/Linux，保留兜底）
app.on('activate', function () {
    if (!mainAlive()) {
        createMainWindow(loadConfig())
    }
})
