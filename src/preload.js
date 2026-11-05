// 主窗口 preload：页面 hook 宿主（通知转发 + 图片独立查看 + 视频右键另存）。
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

    // ---------- 聊天图片 → 独立查看窗口 / 右键保存 ----------
    // 气泡是 _MIDDLE 半分辨率、原图是 CDN 密文（解密在飞书 worklet 内），
    // 只有官方查看器能拿到全分辨率 blob。官方查看器容器被常驻 style 压成
    // display:none（img 照常解码）；专职容器 #__lark-web-images-container__
    // 每次查看图片时更新内容，其 img 自带 data-origin-key（同图恒定）与
    // data-origin-url（解密就绪才为 blob:）。observer 盯这个容器：抓到
    // 就绪原图转 dataURL，按 elkSaveImageKey 路由——匹配（右键保存所点
    // 图）→ 存盘，否则弹独立窗口（同图去重在主进程按 key 做）；两路
    // 完成后代点 .viewer-close 关掉被隐藏的官方查看器
    var elkHideViewer = function () {
        if (document.getElementById('elk-viewer-hide')) return;
        var st = document.createElement('style');
        st.id = 'elk-viewer-hide';
        st.textContent = '.viewer-container.viewer-backdrop{display:none !important}';
        (document.head || document.documentElement).appendChild(st);
    };
    // blob → dataURL（FileReader 保留原始编码，JPEG 不膨胀成 PNG）
    var blobToDataUrl = function (blobUrl, cb) {
        fetch(blobUrl).then(function (r) { return r.blob(); }).then(function (b) {
            var fr = new FileReader();
            fr.onload = function () { cb(fr.result); };
            fr.onerror = function () { cb(null); };
            fr.readAsDataURL(b);
        }).catch(function () { cb(null); });
    };
    var sendImageWindow = function (dataUrl, key) {
        try {
            ipcRenderer.send('open-image-window', { src: dataUrl, key: key || '' });
        } catch (e) {
            console.log('图片窗口 IPC 失败', e);
        }
    };
    var elkSaveImageName = '';   // 右键保存时的原文件名（fiber mediaContent/name）
    var sendImageSave = function (dataUrl, key) {
        try {
            ipcRenderer.send('save-image', JSON.stringify({ src: dataUrl, name: elkSaveImageName, key: key || '' }));
        } catch (elk_e) {
            console.log('elk save-image IPC 失败', elk_e);
        }
    };
    // 右键"保存到本地"的路由键（三级取值见注入项点击处）；'*' 为通配
    // 兜底——保存点击必然紧跟气泡点击触发解密，下一个就绪图即目标。
    // 存盘后清除，恢复弹窗
    var elkSaveImageKey = null;
    // 抓取完成后关闭官方查看器：代点其关闭按钮（按钮随查看器被隐藏，
    // 但 click 仍冒泡到 React root 委托触发组件 onClose，不经全局键盘
    // 路由）；viewer-open 摘除即回普通聊天态，下次点图照常重新打开
    var elkCloseViewer = function () {
        if (document.body.className.indexOf('viewer-open') < 0) return;
        var btn = document.querySelector('.viewer-close');
        if (btn) btn.click();
    };
    var elkTryOpen = function () {
        var host = document.getElementById('__lark-web-images-container__');
        if (host == null) return;
        var imgs = host.querySelectorAll('img[data-origin-key]');
        for (var i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            var key = im.getAttribute('data-origin-key');
            var src = im.getAttribute('data-origin-url') || '';
            if (!key || src.indexOf('blob:') !== 0) continue;   // 原图未就绪
            (function (key, src) {   // 闭包捕获本次迭代的 key/src
                blobToDataUrl(src, function (dataUrl) {
                    if (!dataUrl) return;
                    if (elkSaveImageKey === '*' || key === elkSaveImageKey) {
                        elkSaveImageKey = null;
                        sendImageSave(dataUrl, key);
                    } else {
                        sendImageWindow(dataUrl, key);
                    }
                    elkCloseViewer();
                });
            })(key, src);
        }
    };
    // 容器随首次查看图片才创建（可能远晚于 DOMContentLoaded）：先挂 body
    // observer 等它出现；出现即退役 body observer（容器一旦创建永不删除），
    // 改盯容器自身并补扫一次——容器创建与内容填充常在同一批 mutation 完成，
    // 改挂完成时内容已定稿、不会再有事件可触发，不补扫首击的图就漏掉
    var elkImagesWatched = false;
    var elkBodyObserver = null;
    var elkWatchImages = function () {
        if (elkImagesWatched) return;
        var host = document.getElementById('__lark-web-images-container__');
        if (host == null) return;
        elkImagesWatched = true;
        if (elkBodyObserver) { elkBodyObserver.disconnect(); elkBodyObserver = null; }
        new MutationObserver(elkTryOpen).observe(host, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ['src', 'data-origin-url'],
        });
        elkTryOpen();
    };
    // observer 需 DOM ready 后挂（preload 在 document-start 跑，body 尚
    // 为 null，同步 observe 抛异常会杀死后续 hook）
    var elkInstallViewerWatch = function () {
        elkHideViewer();
        elkWatchImages();   // 容器可能早已存在（本次导航前看过图）
        if (elkImagesWatched) return;
        elkBodyObserver = new MutationObserver(elkWatchImages);
        elkBodyObserver.observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', elkInstallViewerWatch);
    } else {
        elkInstallViewerWatch();
    }

    // ---------- 消息右键菜单：注入"保存到本地"（视频/图片） ----------
    // 官方"下载视频"被服务端权限拦截（视频可播放），这里克隆官方菜单项
    // 注入"保存到本地"。视频由主进程带登录态重拉播放器流地址落盘（只取
    // 播放器产出的真实地址，不构造 API 直链，接口改版免适配：播放过直接
    // 读 <video>；未播放则点封面代播，挂载后立即暂停）。图片走隐藏查看
    // 器抓原图存盘（见图片段）。锚点文本 → {kind, 注入文案}，跟随界面
    // 语言，视频/图片各锚自己的官方下载项（"转发"两边的菜单都有，不能
    // 当锚点）。文件消息不走此路：服务端按消息类型 403 拦截（视频放行、
    // 文件拒绝，已实测），客户端无法绕过。
    var ELK_ANCHORS = {
        '下载视频': { kind: 'video', text: '保存到本地' },
        'download video': { kind: 'video', text: 'Save to Disk' },
        '下载原图': { kind: 'image', text: '保存到本地' },
        'download full image': { kind: 'image', text: 'Save to Disk' },
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
        var spec = ELK_ANCHORS[(anchor.textContent || '').trim().toLowerCase()];
        if (!spec) return;
        if (anchor.parentElement.querySelector('[' + ELK_MARK + ']')) return;
        var clone = anchor.cloneNode(true);   // 样式全带；不复制 React expando，对飞书惰性
        clone.setAttribute(ELK_MARK, spec.kind);
        // 只替换非空文本节点：官方项里还有空文本节点（尾部
        // ud__empty-inline-element 占位 SPAN 内），填入文字会把它撑到
        // 200px+ 高，菜单出现"一大片空白"
        var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        var tn;
        while ((tn = walker.nextNode())) {
            if ((tn.nodeValue || '').trim()) tn.nodeValue = spec.text;
        }
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

    // 从消息气泡沿 fiber 上溯读元数据（Immutable Record 须经 .get 取值）：
    // 视频取 content.mediaContent.name / 图片取 content.name 作命名兜底。
    // message prop 有两种形态：包裹 record（真身在 .message 键下）或消息
    // record 本身（content 直接在其上）——两种都试；content 缺失不 break，
    // 继续上溯找下一个带 message 的 fiber
    var elkFromFiber = function (start, pick) {
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
                    if (!inner || typeof inner.get !== 'function') inner = msg;
                    var c = inner.get('content');
                    if (!c || typeof c.get !== 'function') continue;
                    var v = pick(c);
                    if (typeof v === 'string' && v) return v;
                }
            }
        } catch (e) { /* 结构改版时静默走兜底 */ }
        return '';
    };
    var elkFileNameFromFiber = function (start) {
        return elkFromFiber(start, function (c) {
            var mc = c.get('mediaContent');
            var name = (mc && typeof mc.get === 'function') ? mc.get('name') : '';
            return name || c.get('name');
        });
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

    // 注入项点击：捕获 + stopPropagation，飞书 root 委托收不到。
    // kind=image：记 key/文件名后点气泡触发解密，observer 按 key 路由
    // 存盘（见 elkTryOpen）；kind=video：走视频取流保存
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        var hit = (t && t.closest) ? t.closest('[' + ELK_MARK + ']') : null;
        if (!hit) return;
        ev.stopPropagation();
        ev.preventDefault();
        elkDismissMenu();
        elkStopWatch();

        if (hit.getAttribute(ELK_MARK) === 'image') {
            // key 三级来源：①气泡 img 自带 data-lark-image-uri="imkey://<key>?"
            // （image 消息与 post 富文本内嵌图统一有效，最稳）；②fiber
            // content.image.origin.key（image 消息）；③'*' 通配兜底（下一次
            // 就绪图即目标——保存点击必然紧跟气泡点击触发解密）
            var bubble = elkCtxTarget && elkCtxTarget.tagName === 'IMG'
                ? elkCtxTarget : (elkCtxContainer && elkCtxContainer.querySelector('img'));
            var uriKey = '';
            if (bubble) {
                var uri = bubble.getAttribute('data-lark-image-uri') || '';
                uriKey = uri.replace(/^imkey:\/\//, '').split('?')[0];
            }
            elkSaveImageKey = uriKey
                || elkFromFiber(elkCtxContainer || elkCtxTarget, function (c) {
                    var im = c.get('image');
                    var origin = (im && typeof im.get === 'function') ? im.get('origin') : null;
                    return (origin && typeof origin.get === 'function') ? origin.get('key') : '';
                })
                || '*';
            // 文件名：fiber 读消息元数据（image 消息有 content.name）；post
            // 内嵌图消息数据里本无文件名，留空交主进程用图片 key 尾段命名
            elkSaveImageName = elkFileNameFromFiber(elkCtxContainer || elkCtxTarget);
            if (bubble) bubble.click();
            return;   // 图片分支到此为止；找不到气泡图时不落入视频路径
        }

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
    }, true);
})();
