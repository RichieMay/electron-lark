'use strict';

const appConf = require("./configuration")

const electron = require('electron')
const fs = require('fs')
const path = require('path')
const updateChecker = require('./updateChecker')

const shell = electron.shell;
const app = electron.app;
const ipcMain = electron.ipcMain;
const BrowserWindow = electron.BrowserWindow;
const Notification = electron.Notification;
const Menu = electron.Menu;

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

// electron-context-menu 4.x 起为纯 ESM 包，主进程(CommonJS)需用动态 import() 加载
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
    });
}).catch(err => console.error("electron-context-menu 加载失败:", err));

if (process.mas) app.setName('飞书Feishu');
// Windows 通知依赖 AUMID，需与 electron-builder NSIS 快捷方式写入的 appId 一致，
// 否则打包后 Notification 全部静默不弹（消息提醒/更新提示/下载完成都会受影响）
if (process.platform === 'win32') {
    app.setAppUserModelId('com.richiemay.electron-lark');
}

// userData 目录固定为 ElectronLark（与 NSIS 卸载脚本删除的目录一致）
// 须在 app ready 之前执行
app.setPath('userData', path.join(app.getPath('appData'), 'ElectronLark'));

// fixup High CPU Usage issue
// see https://github.com/electron/electron/issues/11908
app.disableHardwareAcceleration();

// 是否处于焦点，检点监听
let onFocus = false;
app.on('browser-window-blur', function () {
    onFocus = false;
})
app.on('browser-window-focus', function () {
    onFocus = true;
})

let newAppTray = null;
const dock32Icon = electron.nativeImage.createFromPath(appConf.dock32)
const dock32EmptyIcon = electron.nativeImage.createFromPath(appConf.dock32Empty)

// // 菜单 Template 
// const appMenu = require("./windows/app_menu")

const globalShortcut = electron.globalShortcut;

let mainWindow
let webContents

function createWindow(configJson) {
    mainWindow = new BrowserWindow({
        width: LOGIN_WINDOW_SIZE.width,
        height: LOGIN_WINDOW_SIZE.height,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: appConf.icon128
    })

    // 登录状态驱动的窗口尺寸切换：
    // 进入登录页 → 小尺寸；离开登录页(登录成功) → 大尺寸。
    // 用户调整过的尺寸只在登录后的会话内自然保持，重新登录时重置为默认
    let windowSizeStage = 'login';
    mainWindow.webContents.on('did-navigate', (event, url) => {
        if (isLoginUrl(url)) {
            if (windowSizeStage !== 'login') {
                windowSizeStage = 'login';
                applyWindowSize(mainWindow, LOGIN_WINDOW_SIZE);
            }
        } else {
            if (windowSizeStage !== 'app') {
                windowSizeStage = 'app';
                applyWindowSize(mainWindow, APP_WINDOW_SIZE);
            }
        }
    });

    // mainWindow.loadFile('index.html')
    // 改为使用loadURL加载飞书地址
    let loadUrl = "https://feishu.cn/messenger/";
    if (configJson.startPageLink !== undefined
        && configJson.startPageLink != null
        && configJson.startPageLink.trim() != "") {
        loadUrl = configJson.startPageLink
    }
    console.log("load main page: " + loadUrl)
    mainWindow.loadURL(loadUrl, {
        userAgent: APP_USER_AGENT
    })
    webContents = mainWindow.webContents
    mainWindow.on('closed', function () {
        mainWindow = null
    })

    mainWindow.on('close', (event) => {
        mainWindow.hide();
        mainWindow.setSkipTaskbar(true);
        event.preventDefault();
    });

    let showWarterMark = false;
    if(configJson.showWarterMark !== undefined
        && configJson.showWarterMark != null) {
        showWarterMark = configJson.showWarterMark;
    }

    // 窗口加载完成后运行
    // 关于图标的闪烁，方法是每1.5s做一个轮询，查看是否有未读消息提醒，如果有的话就闪烁
    // 侧边栏 class 为 larkc-badge-count circle navbarMenu-badge larkc-badge-normal
    webContents.on("did-finish-load", function() {
        setInterval(() => {
            if(mainWindow != null && !mainWindow.isVisible){
                return
            }
            webContents.executeJavaScript(`document.getElementsByClassName('larkc-badge-count circle larkc-badge-normal').length`)
                .then(function(result){
                    if(parseInt(result) > 0) {
                        startBlingIcon();
                    } else {
                        stopBlingIcon();
                    }
                })
            if(!showWarterMark) {
                webContents.executeJavaScript(`if(document.getElementsByClassName('lark-water-mark-main').length > 0) document.getElementsByClassName('lark-water-mark-main')[0].remove()`)
            }
        }, 1500);
        
        // 注入 js，hack html5 的 Notification 接口，并将通知内容转发到 main.js 里
        webContents.executeJavaScript(`
            let ipcRenderer = null;
            try{ipcRenderer = require('electron').ipcRenderer} catch(e) {}
            let oldNotification = window.Notification;
            let newNotification = function(title, opt){
                console.log("hack-title:" + title);
                console.log("hack-opt:" + JSON.stringify(opt));
                if(ipcRenderer != null) {
                    let sendMsg = JSON.stringify({
                        title: title,
                        opt: opt
                    })
                    try {
                        ipcRenderer.send("notification", sendMsg);
                    } catch (e) {
                        console.log("发送 ipc 消息报错", e);
                        return new oldNotification(title,opt);
                    }
                } else {
                    return new oldNotification(title,opt);
                }
            }
            newNotification.requestPermission = oldNotification.requestPermission.bind(oldNotification);
            Object.defineProperty(newNotification, 'permission', {
                get: () => {
                    return oldNotification.permission;
                }
            });
            window.Notification = newNotification;`);

            // 在页面加载完成之后，检查新版本信息
            updateChecker.checkInAppStart();
            // 每天 16:00 定时再静默检查一次
            updateChecker.startDailyCheck();
    })

    // 定义在 electron 内部打开的 url，除此之外的 url 都跳转浏览器打开，使用 indexOf >= 0 来判断
    // 飞书域名默认留在应用内打开：文件/预览链接若转交系统浏览器会丢失登录态，报 session key not found
    let electronUrl = [
        "feishu.cn",
        "larksuite.com",
    ]
    if (configJson.larkOpenLink !== undefined && configJson.larkOpenLink !== null
        && ("" + configJson.larkOpenLink).trim() !== ""){
        electronUrl = electronUrl.concat(("" + configJson.larkOpenLink).split("\n"))
    }

    // 拦截新窗口打开，决定在应用内打开还是跳转系统浏览器
    // （Electron 22 起移除了 new-window 事件，改用 setWindowOpenHandler）
    // feishu.cn/calendar/ 日历
    // feishu.cn/space/home/ 文档
    webContents.setWindowOpenHandler(({ url }) => {
        console.log("open url " + url)

        let openInElectron = false
        for(let i=0;i<electronUrl.length; i++){
            if(electronUrl[i].trim() != "" && url.indexOf(electronUrl[i]) >= 0) {
                openInElectron = true;
                console.log("open url electron")
                break;
            }
        }

        if(!openInElectron && url.startsWith("http")) {
            // 其余链接交给系统默认浏览器打开
            shell.openExternal(url)
        }
        return {
            action: openInElectron ? 'allow' : 'deny',
            overrideBrowserWindowOptions: {
                width: 1200,
                height: 600,
                show: false,
            }
        }
    })

    // 应用内新窗口（如文件预览页）加载完成后再显示，并统一设置 UA
    webContents.on("did-create-window", (childWindow) => {
        // 将所有打开的新页面的 user agent 也重新设置，避免提示浏览器错误
        childWindow.webContents.setUserAgent(APP_USER_AGENT)
        childWindow.once('ready-to-show', () => childWindow.show())
    })

    // 打开开发者模式
    // mainWindow.toggleDevTools()
}

let blingCount = 0;
let blingTimer = null;
let bling = false;
function startBlingIcon() {
    // 部分修复ubuntu18.04 下面锁屏之后 dock 图标一直不显示的问题
    // 每次 start bling 之前重新设置一遍
    // 保证哪怕因为锁屏而 dock 图标消失之后，收到新消息也可以闪烁
    // appTray.appTray.destroy()
    // appTray.init(electron, app, mainWindow)

    // 如果是焦点的话，就不闪烁
    if (onFocus && mainWindow.isVisible()) {
        stopBlingIcon()
        return
    }
    if (blingTimer != null) {
        return
    }
    bling = true;
    blingTimer = setInterval(function () {
        blingCount++;
        if (blingCount % 2 == 0) {
            newAppTray.setImage(dock32EmptyIcon)
        } else {
            newAppTray.setImage(dock32Icon)
        }
        // 避免 count 无限增大
        if(blingCount == 1000) blingCount = 0
    }, 500);
}

function stopBlingIcon() {
    if(bling) {
        if (blingTimer != null) {
            clearInterval(blingTimer)
            blingTimer = null;
        }
        newAppTray.setImage(dock32Icon)
        bling = false;
    }
}


// 修复 Application Menu上图标不显示
if (process.env.XDG_CURRENT_DESKTOP == 'ubuntu:GNOME') {
    process.env.XDG_CURRENT_DESKTOP = 'Unity';
}

const trayMenuTemplate = [
    {
        label: '显示主界面',
        click: function(){
            if(mainWindow != null){
                mainWindow.show()
            }
        }
    },
    {
        label: '系统设置',
        click: function(){
            openSettingsWindows();
        }
    },
    {
        type: 'separator'
    },
    {
        label: '退出程序',
        click: function(){
            console.log("从 tray 退出")
            app.quit();
            mainWindow.destroy()
        }
    }
];
const contextMenu = electron.Menu.buildFromTemplate(trayMenuTemplate)

function appTrayInit(){
    newAppTray = new electron.Tray(dock32Icon);
    newAppTray.setToolTip('Feishu');
    newAppTray.setContextMenu(contextMenu);
    newAppTray.on('click',function () {
        stopBlingIcon();
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
        mainWindow.isVisible() ? mainWindow.setSkipTaskbar(false) : mainWindow.setSkipTaskbar(true);
    })
    newAppTray.on('double-click', function() {
        if(mainWindow != null && !mainWindow.isVisible()){
            mainWindow.show()
        }
    })
}

/**
 * 应用内文件下载处理
 * 飞书页面触发的下载自动保存到系统"下载"目录（同名文件自动加序号，不覆盖），
 * 下载完成后系统通知，点击通知打开文件所在文件夹
 */
function initDownload(){
    const ses = electron.session.defaultSession
    // 下载请求由 session 发起，需与页面一致使用新 UA，避免飞书服务端校验失败
    ses.setUserAgent(APP_USER_AGENT)

    // 新版 Chromium 的通知权限模型要求显式授权，不设置的话
    // 飞书页面的 Notification 权限会被拒绝，消息通知静默失效
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
        // notifications: 页面通知（消息提醒）；fullscreen: 文件预览/视频全屏
        callback(permission === 'notifications' || permission === 'fullscreen')
    })

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
            if(!Notification.isSupported()) return
            if(state === 'completed') {
                let notify = new Notification({
                    title: "下载完成",
                    subtitle: "下载完成",
                    body: filename,
                    icon: electron.nativeImage.createFromPath(appConf.dock32),
                });
                notify.addListener('click', function(){
                    electron.shell.showItemInFolder(savePath)
                });
                notify.show();
            } else {
                new Notification({
                    title: "下载失败",
                    subtitle: "下载失败",
                    body: filename + " (" + state + ")",
                    icon: electron.nativeImage.createFromPath(appConf.dock32Empty),
                }).show();
            }
        })
    })
}

/**
 * 按用户配置应用网络代理（config.json 的 proxyMode/proxyPacUrl/proxyServer）
 * 作用于整个默认会话：飞书页面加载、文件下载、更新检查(electron.net)全部生效
 *   system: 跟随系统代理（默认，不设置即为此行为）
 *   pac:    使用 PAC 自动配置脚本
 *   fixed:  固定代理服务器（http/https/socks4/socks5）
 *   direct: 所有连接直连
 */
function initProxy(configJson){
    const ses = electron.session.defaultSession
    const mode = configJson.proxyMode

    if(mode === 'pac'){
        const pacUrl = (configJson.proxyPacUrl || "").trim()
        if(pacUrl !== ""){
            console.log("使用 PAC 代理: " + pacUrl)
            ses.setProxy({ pacUrl: pacUrl })
            return
        }
        console.log("PAC 模式但未配置脚本地址，回退系统代理")
    }

    if(mode === 'fixed'){
        const server = (configJson.proxyServer || "").trim()
        if(server !== ""){
            console.log("使用固定代理: " + server)
            ses.setProxy({ proxyRules: server })
            return
        }
        console.log("fixed 模式但未配置服务器地址，回退系统代理")
    }

    if(mode === 'direct'){
        console.log("所有连接直连")
        ses.setProxy({ mode: 'direct' })
        return
    }

    // system 或无效配置：跟随系统代理
    ses.setProxy({ mode: 'system' })
}

function getConfigJson(callback){
    fs.readFile('config.json','utf-8',function(err,data){
        if(err){
            console.error("load config error, may be have no config file~");
            callback({})
        }
        else{
            console.log("read config json:" + data);
            callback(JSON.parse(data))
        }
    });
}


// ------------------------ 程序菜单 --------------------------------
// 应用不再显示菜单栏（所有入口集中到托盘菜单）
// 需要开发者工具时可用快捷键 Ctrl+Shift+I


/**
 * 打开设置窗口
 * page 参数为设置页内的页签（如 about-info 直接打开"关于"页），可选
 */
function openSettingsWindows(page){
    let settingsWindow = null;
    if(settingsWindow == null) {
        settingsWindow = new BrowserWindow({
            width: 700,
            height: 650,
            frame: false,
            // height: 200,
            resizable: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
        });

        // console.log(settingsWindow)
        // settingsWindow.loadUrl('file://' + __dirname + '/app/settings.html');
        settingsWindow.setMenuBarVisibility(false);
        // 通过 hash 指定初始页签（如 #about-info 直接打开"关于"页）
        let hash = (page != null && page !== '') ? ('#' + page) : ''
        settingsWindow.loadURL('file://' +__dirname+ '/windows/views/settings.html' + hash);
        // settingsWindow.toggleDevTools();
    }
}

// ------------------------ App ------------------------------------
app.on('ready', function () {

    // 删除菜单栏，所有入口集中到托盘菜单
    Menu.setApplicationMenu(null)

    // 系统托盘设置
    // 托盘图标
    appTrayInit()

    // 应用内文件下载处理
    initDownload()

    // globalShortcut.register('alt+shift+q', () => {
    //     console.log("托盘销毁情况")
    //     console.log(newAppTray.isDestroyed())
    // })

    globalShortcut.register('alt+shift+m', () => {
        mainWindow.show()
    })

    // app on 了之后先进行 ajax 请求配置详情，成功之后再 createWindows
    getConfigJson(function (json){
        console.log(json)
        // 先应用代理配置，再创建窗口，保证首个页面加载就按代理走
        initProxy(json);
        createWindow(json);
    })

})

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (win == null) {
        createWindow();
    }
})

// 接受从载入页面发送过来的通知消息
ipcMain.on("notification", (event, msg) => {
    // console.log("收到消息")
    // console.log(event)
    // console.log(msg)
    let args = JSON.parse(msg)
    // let title = args.title;
    // let opt = args.opt;
    // console.log(args.title, args.opt);
    // title 是对话框名称，opt 是聊天的具体内容，想看格式的话可以去掉上面那行注释
    showLarkNotify(args.title, args.opt, args.opt.channelId)
    event.returnValue = 'pong'
})

// 设置页发起的检查更新请求（通知由 updateChecker 内部弹出）
ipcMain.on("check-update", (event) => {
    console.log("收到设置页检查更新请求")
    updateChecker.check(true);
    event.returnValue = 'ok'
})

function showLarkNotify(title, opt, channelId){
    if(Notification.isSupported()) {
        let electronNotification = new Notification({
            title: title,
            subtitle : title,
            body : opt.body,
            icon: electron.nativeImage.createFromPath(appConf.dock32),
        });
        electronNotification.addListener('click', function(){
            if(mainWindow != null) mainWindow.show();
            // 通过注入 js 打开具体的对话聊天框
            // 参考 https://github.com/Ericwyn/electron-lark/commit/f8c4781fab5c6cd704aa2bba4be0d4d0cedcaab1#commitcomment-51571446
            if(webContents != null) {
                try{webContents.executeJavaScript(`
                    var doms = document.getElementsByTagName("div");
                    for(let i =0;i<doms.length;i++){
                        if(doms[i].getAttribute("data-feed-id") == '${channelId}') {
                            doms[i].click();
                            break;
                        }
                    }
                `)}catch(e){
                    console.log(e);
                }
            }
        })
        electronNotification.show();
    }
}