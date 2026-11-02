// 主窗口 preload：页面 hook 宿主（通知转发 + 图片点击拦截）。
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
})();
