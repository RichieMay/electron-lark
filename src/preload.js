// 主窗口 preload：页面 hook 宿主（通知转发 + 图片点击拦截 + 视频右键另存）。
// preload 在每个新文档创建时、页面脚本运行前自动执行，天然覆盖所有
// 导航与重定向——executeJavaScript 注入在飞书（SSE 挂起 + 登录重定向）
// 下时序不可靠，不可用。
// 本窗口 nodeIntegration:true + contextIsolation:false，preload 与页面
// 共享上下文，window 上的赋值对页面直接可见。
(function () {
    'use strict';
    if (window.__elkHookInstalled) return;
    window.__elkHookInstalled = true;

    var ipcRenderer = require('electron').ipcRenderer;

    // ---------- 通知转发 ----------
    // 替换 html5 Notification 与 ServiceWorkerRegistration.showNotification，
    // 将通知转发给主进程（新版飞书可能改走 Service Worker 发通知）
    var sendNotify = function (title, opt) {
        try {
            ipcRenderer.send('notification', JSON.stringify({ title: title, opt: opt }));
            return true;
        } catch (e) {
            console.log('发送 ipc 消息报错', e);
            return false;
        }
    };

    var oldNotification = window.Notification;
    // 飞书会持有 new Notification() 的返回值并调用其方法（如已读消息时
    // close()），成功转发后返回 stub 对象而非 undefined，
    // 否则飞书侧抛 "t.close is not a function"
    var makeStub = function (title, opt) {
        var listeners = {};
        var fire = function (type) {
            setTimeout(function () {
                var handlers = listeners[type] || [];
                for (var i = 0; i < handlers.length; i++) handlers[i]({ type: type });
                var on = stub['on' + type];
                if (typeof on === 'function') on({ type: type });
            }, 0);
        };
        var stub = {
            title: title,
            body: opt && opt.body,
            icon: opt && opt.icon,
            tag: opt && opt.tag,
            silent: !!(opt && opt.silent),
            show: function () { },
            close: function () { fire('close') },
            addEventListener: function (type, fn) {
                (listeners[type] = listeners[type] || []).push(fn);
            },
            removeEventListener: function (type, fn) {
                var arr = listeners[type] || [];
                var idx = arr.indexOf(fn);
                if (idx >= 0) arr.splice(idx, 1);
            },
            dispatchEvent: function () { return false }
        };
        return stub;
    };
    var newNotification = function (title, opt) {
        if (!sendNotify(title, opt)) {
            return new oldNotification(title, opt);
        }
        return makeStub(title, opt);
    };
    newNotification.requestPermission = oldNotification.requestPermission.bind(oldNotification);
    Object.defineProperty(newNotification, 'permission', {
        get: function () { return oldNotification.permission; }
    });
    window.Notification = newNotification;
    if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype) {
        var oldShow = ServiceWorkerRegistration.prototype.showNotification;
        if (typeof oldShow === 'function') {
            ServiceWorkerRegistration.prototype.showNotification = function (title, opt) {
                sendNotify(title, opt);
                return oldShow.call(this, title, opt);
            };
        }
    }

    // ---------- 主进程页面 toast ----------
    // 系统通知不可用（如 WSL 无通知服务）时，主进程经此通道在页面右下角
    // 弹 toast；页面内直接操作 DOM（executeJavaScript 在飞书 SSE 场景下
    // 时序不可靠，见文件头注释）
    ipcRenderer.on('page-toast', function (_ev, text) {
        try {
            var old = document.getElementById('elk-toast');
            if (old) old.remove();
            var toast = document.createElement('div');
            toast.id = 'elk-toast';
            toast.textContent = text;
            toast.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;'
                + 'background:rgba(33,33,33,0.92);color:#fff;padding:12px 20px;border-radius:8px;'
                + 'font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,0.3);'
                + 'max-width:360px;line-height:1.5;white-space:pre-wrap;';
            document.body.appendChild(toast);
            setTimeout(function () { toast.remove(); }, 5000);
        } catch (e) { /* 页面卸载瞬间可忽略 */ }
    });

    // ---------- 聊天图片点击 → 独立查看窗口 ----------
    // 聊天图片 IMG 的父链含 chat-image/image-message/messenger-image 容器；
    // 表情/头像 URL 含 emoji/sticker/avatar，放行维持飞书原生行为。
    // 大图 src 是 blob:（仅本渲染进程可访问），命中后经 canvas 转成
    // dataURL 再交主进程弹独立窗口
    var imgSrcOf = function (img) {
        return (img.currentSrc || img.src || '');
    };
    var isChatImage = function (img) {
        // 祖先链含聊天图片容器特征 → 图片消息
        var n = img.parentNode;
        while (n && n !== document.body) {
            var c = typeof n.className === 'string' ? n.className : '';
            if (c.indexOf('chat-image') >= 0 || c.indexOf('image-message') >= 0
                || c.indexOf('messenger-image') >= 0) return true;
            n = n.parentNode;
        }
        return false;
    };
    var isExemptImage = function (img) {
        var s = imgSrcOf(img).toLowerCase();
        if (s.indexOf('emoji') >= 0 || s.indexOf('sticker') >= 0
            || s.indexOf('avatar') >= 0) return true;
        return false;
    };
    // 事件 target 向上找 IMG；找不到则取命中点下所有元素里的第一个 IMG
    var findImg = function (ev) {
        var node = ev.target;
        while (node && node !== document.body) {
            if (node.tagName === 'IMG') return node;
            node = node.parentNode;
        }
        var stack = document.elementsFromPoint(ev.clientX, ev.clientY) || [];
        for (var i = 0; i < stack.length; i++) {
            if (stack[i].tagName === 'IMG') return stack[i];
        }
        return null;
    };
    // 图片 → dataURL；blob/http 图在页面内转换，独立窗口可直接显示
    var toDataUrl = function (img, cb) {
        var src = imgSrcOf(img);
        if (src.indexOf('data:') === 0) { cb(src); return }
        try {
            var c = document.createElement('canvas');
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            if (c.width === 0 || c.height === 0) { cb(src); return }
            c.getContext('2d').drawImage(img, 0, 0);
            cb(c.toDataURL('image/png'));
        } catch (e) {
            // canvas 被污染等异常时退回原始地址（http 图仍可直开）
            console.log('elk canvas 转换失败: ' + e.message);
            cb(src);
        }
    };
    document.addEventListener('click', function (ev) {
        var img = findImg(ev);
        if (img == null) return               // 与图片无关，放行
        if (!isChatImage(img)) return         // 非聊天图片消息，放行
        if (isExemptImage(img)) return        // 表情/头像，放行给飞书
        ev.stopPropagation();
        ev.preventDefault();
        toDataUrl(img, function (dataUrl) {
            try {
                ipcRenderer.send('open-image-window', dataUrl);
            } catch (e) {
                console.log('图片窗口 IPC 失败', e);
            }
        });
    }, true);

    // ---------- 聊天视频消息右键菜单：注入"保存到本地" ----------
    // 官方"下载视频"被服务端权限拦截（视频可播放），这里克隆官方菜单项注入
    // "保存到本地"，由主进程带登录态重拉流，按官方下载行为落盘。
    // 流地址只取播放器产出的真实地址（不构造 API 直链，接口改版免适配）：
    // 播放过直接读 <video>；未播放则点封面代播，挂载后立即暂停。
    // 锚点文本 → 注入文案（跟随界面语言）；未播放时菜单无"下载视频"项，
    // 锚到各语言最稳定的"转发"。文件消息不走此路：服务端按消息类型
    // 403 拦截（视频放行、文件拒绝，已实测），客户端无法绕过。
    var ELK_ANCHORS = {
        '下载视频': '保存到本地', 'download video': 'Save to Disk',
        '转发': '保存到本地', 'forward': 'Save to Disk',
    };
    var ELK_MARK = 'data-elk-save-as';
    var elkMenuObserver = null;
    var elkWatchTimer = null;
    var elkCtxTarget = null;     // 最近一次右键的 target，用于回找 video
    var elkCtxContainer = null;  // 右键所在消息气泡，代播后 DOM 重建仍可重查

    // 找文本全等锚点文案的可见叶子，上溯到只含该文本的最外层包装（菜单项
    // 容器）；父容器有多个子项说明是菜单而非正文文本
    var elkFindAnchor = function () {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
            if (!ELK_ANCHORS.hasOwnProperty((node.nodeValue || '').trim().toLowerCase())) continue;
            var item = node.parentElement;
            if (item == null || item.offsetParent === null) continue;
            while (item.parentElement
                && ELK_ANCHORS.hasOwnProperty((item.parentElement.textContent || '').trim().toLowerCase())) {
                item = item.parentElement;
            }
            if (item.parentElement && item.parentElement.children.length >= 2) return item;
        }
        return null;
    };

    var elkInject = function (anchor) {
        if (anchor.parentElement.querySelector('[' + ELK_MARK + ']')) return;
        var saveText = ELK_ANCHORS[(anchor.textContent || '').trim().toLowerCase()] || 'Save to Disk';
        var clone = anchor.cloneNode(true);   // 样式全带；不复制 React expando，对飞书惰性
        clone.setAttribute(ELK_MARK, '1');
        var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        var tn;
        while ((tn = walker.nextNode())) tn.nodeValue = saveText;
        anchor.parentElement.insertBefore(clone, anchor.nextSibling);
    };

    var elkStopWatch = function () {
        if (elkMenuObserver) { elkMenuObserver.disconnect(); elkMenuObserver = null; }
        clearTimeout(elkWatchTimer);
        // 清理菜单容器复用（仅隐藏未卸载）时遗留的克隆体
        var stray = document.querySelectorAll('[' + ELK_MARK + ']');
        for (var i = 0; i < stray.length; i++) {
            if (stray[i].offsetParent === null) stray[i].remove();
        }
    };

    // 菜单在 contextmenu 后 ~300ms 内出现；只在右键后的短窗口观察，
    // 常驻 body subtree observer 在 IM 高频重渲染下开销大且无必要
    var elkScan = function () {
        var item = elkFindAnchor();
        if (item) { elkInject(item); elkStopWatch(); }
    };
    var elkStartWatch = function () {
        clearTimeout(elkWatchTimer);   // 连续右键时重置超时
        elkWatchTimer = setTimeout(elkStopWatch, 2500);
        if (elkMenuObserver) { elkScan(); return }
        elkMenuObserver = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                if (muts[i].addedNodes.length > 0) { elkScan(); break; }
            }
        });
        elkMenuObserver.observe(document.body, { childList: true, subtree: true });
        elkScan();   // 菜单可能同步渲染完成
    };

    // 右键不拦截（不影响飞书原生菜单），记 target + 消息气泡供取流/代播
    document.addEventListener('contextmenu', function (ev) {
        elkCtxTarget = ev.target;
        elkCtxContainer = (ev.target.closest && ev.target.closest('[class*="message-section"]'))
            || ev.target.parentElement || null;
        elkStartWatch();
    }, true);

    // 从右键位置找视频元素：先沿父链直找，再上溯找最近含 VIDEO 的祖先
    // （覆盖右键落在悬浮控制条等 video 兄弟节点上的情况）
    var elkFindVideo = function (start) {
        var n = start;
        while (n && n !== document.body) {
            if (n.tagName === 'VIDEO') return n;
            n = n.parentNode;
        }
        n = start;
        while (n && n !== document.body) {
            if (n.querySelector) {
                var v = n.querySelector('video');
                if (v) return v;
            }
            n = n.parentNode;
        }
        return null;
    };

    // 从消息气泡沿 fiber 上溯读元数据里的原始文件名（视频消息在
    // content.mediaContent.name，Immutable Record 须经 .get 取值）。
    // 仅作主进程的命名兜底，流地址本身仍只来自播放器
    var elkFileNameFromFiber = function (start) {
        try {
            var n = start;
            for (var hop = 0; hop < 10 && n && n !== document.body; hop++, n = n.parentElement) {
                var fk = null;
                for (var k in n) { if (k.indexOf('__reactInternalInstance$') === 0) { fk = k; break; } }
                if (!fk) continue;
                var f = n[fk];
                for (var u = 0; u < 40 && f; u++, f = f.return) {
                    var msg = f.memoizedProps && f.memoizedProps.message;
                    if (!msg || typeof msg.get !== 'function') continue;
                    var inner = msg.get('message');
                    if (!inner || typeof inner.get !== 'function') break;
                    var c = inner.get('content');
                    if (!c || typeof c.get !== 'function') break;
                    var mc = c.get('mediaContent');
                    var name = (mc && typeof mc.get === 'function') ? mc.get('name') : '';
                    if (!name) name = c.get('name');
                    return (typeof name === 'string' && name) ? name : '';
                }
            }
        } catch (e) { /* 结构改版时静默走时间戳兜底 */ }
        return '';
    };

    // 关闭飞书菜单：克隆项无 React 事件，点击不会触发飞书自身的关闭逻辑，
    // 补发 Escape + 指针按下；事件须从 React 树内冒泡（委托挂在 root）
    var elkDismissMenu = function () {
        setTimeout(function () {
            try {
                var el = (document.activeElement && document.activeElement !== document.body)
                    ? document.activeElement
                    : (document.body.firstElementChild || document.body);
                el.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', bubbles: true, cancelable: true,
                }));
                document.body.dispatchEvent(new PointerEvent('pointerdown', {
                    bubbles: true, cancelable: true,
                }));
                document.body.dispatchEvent(new MouseEvent('mousedown', {
                    bubbles: true, cancelable: true,
                }));
            } catch (e) { /* 兜底：用户下次点击自然关闭 */ }
        }, 0);
    };

    // 代播：等 <video> 挂载并拿到 http 流地址后立即暂停；超时空串交主进程兜底
    var elkWaitForVideoSrc = function (container, timeoutMs, cb) {
        var waited = 0;
        var timer = setInterval(function () {
            var v = (container && container.isConnected)
                ? container.querySelector('video')
                : document.querySelector('video');
            var src = v ? (v.currentSrc || v.getAttribute('src') || '') : '';
            if (v && src.indexOf('http') === 0) {
                clearInterval(timer);
                try { v.pause(); } catch (e) { }
                cb(src);
                return;
            }
            waited += 200;
            if (waited >= timeoutMs) {
                clearInterval(timer);
                cb('');
            }
        }, 200);
    };

    // 注入项点击：捕获 + stopPropagation，飞书 root 委托收不到
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        var hit = (t && t.closest) ? t.closest('[' + ELK_MARK + ']') : null;
        if (!hit) return;
        ev.stopPropagation();
        ev.preventDefault();

        var fileName = elkFileNameFromFiber(elkCtxContainer || elkCtxTarget);
        var send = function (srcUrl) {
            try {
                ipcRenderer.send('save-video', JSON.stringify({
                    src: srcUrl,
                    pageUrl: location.href,
                    name: fileName,
                }));
            } catch (e) {
                console.log('elk save-video IPC 失败', e);
            }
        };

        // 已挂载 <video>（播放过）直接取地址；否则点封面代播取流
        var srcUrl = '';
        try {
            var v = elkFindVideo(elkCtxTarget)
                || (elkCtxContainer && elkCtxContainer.querySelector('video'));
            if (v) srcUrl = v.currentSrc || v.getAttribute('src') || '';
        } catch (e) { /* 走代播 */ }

        if (srcUrl.indexOf('http') === 0) {
            send(srcUrl);
        } else if (elkCtxContainer && elkCtxContainer.isConnected) {
            elkCtxContainer.click();
            elkWaitForVideoSrc(elkCtxContainer, 8000, send);
        } else {
            send('');
        }
        elkDismissMenu();
        elkStopWatch();
    }, true);
})();
