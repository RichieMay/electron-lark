const appStoreFs = require("fs");
const path = require('path')
const electron = require('electron');
const Notification = electron.Notification;

const appConf = require("./configuration")

// 统一构造带图标的系统通知
function notify(title, body){
    const n = new Notification({
        title: title,
        subtitle: title,
        body: body,
        icon: electron.nativeImage.createFromPath(appConf.dock32),
    });
    n.show();
    return n;
}

// 状态文件落 userData（安装目录不可写，不能用相对路径）。
// 注意不能在模块顶层取 path：main.js 在 app ready 之前 require 本模块，
// 早期时序下 app.getPath 可能不可用，首次用到时再解析
function updateStateFile() {
    return path.join(electron.app.getPath('userData'), 'updateCheck.json')
}

let updateCheckJson;

function getConfigJson(callback){
    if(appStoreFs == null) return
    appStoreFs.readFile(updateStateFile(),'utf-8',function(err,data){
        if(err){
            // 首次启动无状态文件属正常，用初始值
            updateCheckJson = {
                lastCheckUpdateTimeStamp: 0
            }
        }
        else{
            updateCheckJson = JSON.parse(data);
        }
        callback()
    });
}

function saveConfig(){
    if (appStoreFs == null) return;
    appStoreFs.writeFile(updateStateFile(),JSON.stringify(updateCheckJson, null, "  "),function (err) {
        if(err) console.log("更新状态保存失败:", err);
    })
}

function checkUpdateInAppStart(){
    function check(){
        if(updateCheckJson == null) return

        const unixTimeStamp = Math.floor(new Date().getTime() / 1000);
        if(updateCheckJson.lastCheckUpdateTimeStamp == null){
            updateCheckJson.lastCheckUpdateTimeStamp = 0;
        }

        // 每次启动都静默检查（静默模式：无新版/失败都不打扰，仅发现新版本时通知）
        checkUpdate(false, function(){
            updateCheckJson.lastCheckUpdateTimeStamp = unixTimeStamp;
            saveConfig();
        })
    }

    if(updateCheckJson == null){
        getConfigJson(function(){check()});
    } else {
        check();
    }
}

// ------------------------ 定时检查 --------------------------------
// 除启动检查外，每天 16:00 再静默检查一次（应用常驻托盘，长时间不重启也能收到新版提醒）
const DAILY_CHECK_HOUR = 16;
let dailyCheckTimer = null;

function startDailyUpdateCheck(){
    // 页面重载等场景可能重复调用，已有定时器则跳过
    if(dailyCheckTimer != null) return;

    function scheduleNext(){
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
            DAILY_CHECK_HOUR, 0, 0, 0);
        // 今天 16 点已过则排到明天
        if(next.getTime() <= now.getTime()){
            next.setDate(next.getDate() + 1);
        }
        dailyCheckTimer = setTimeout(function(){
            checkUpdate(false, function(){
                if(updateCheckJson != null){
                    updateCheckJson.lastCheckUpdateTimeStamp = Math.floor(new Date().getTime() / 1000);
                    saveConfig();
                }
            });
            // 检查完排下一天
            scheduleNext();
        }, next.getTime() - now.getTime());
    }

    scheduleNext();
}

// 参数: showCheckNotify 是否手动触发(弹系统通知); successCb 完成回调;
//       resultCb 结果回调({type: newer/latest/fail, message}), 用于设置页内反馈(系统通知在部分环境会被静默)
function checkUpdate(showCheckNotify, successCb, resultCb){
    if(successCb == undefined){
        successCb = function(){}
    }
    if(resultCb == undefined){
        resultCb = function(){}
    }

    function notifyCheckFail(reason){
        console.log("检查更新失败: " + reason)
        resultCb({type: 'fail', message: reason})
        if(showCheckNotify) notify("检查更新失败", reason);
    }

    // 用 electron.net 发起请求：走 Chromium 网络栈，自动使用系统代理，
    // 墙内环境下 Node 原生 https 直连 api.github.com 会无限挂起
    const request = electron.net.request({
        url: 'https://api.github.com/repos/RichieMay/electron-lark/releases/latest',
    })
    request.setHeader('User-Agent', 'electron-lark-update-checker')

    let resJsonStr = "";
    let finished = false;

    // 15 秒超时，避免网络不通时点击后毫无反应
    const timeoutTimer = setTimeout(function(){
        if(finished) return;
        finished = true;
        request.abort();
        notifyCheckFail("请求 Github API 超时，请检查网络");
    }, 15000);

    request.on('response', (response) => {
        response.on('data', (data) => {
            resJsonStr += String(data);
        });

        response.on('end', () => {
            if(finished) return;
            finished = true;
            clearTimeout(timeoutTimer);

            let resJson;
            try{
                resJson = JSON.parse(resJsonStr);
            } catch(e){
                notifyCheckFail("Github API 返回数据解析失败");
                return
            }

            if(response.statusCode != 200){
                // 任何非 200（限流、404 等）都给出明确提示，不再静默
                let reason = "Github API 请求失败 (" + response.statusCode + ")";
                if(resJson.message != null) reason = reason + ": " + resJson.message;
                notifyCheckFail(reason);
                successCb();
                return
            }

            let newVersion = String(resJson.tag_name)
                .trim()
                .toLocaleLowerCase()
                .replace("v","");

            // 只要最新版本和当前版本不一样，就提示更新
            const packageVersion = require(path.join(__dirname, './../package.json'))
                .version
                .trim()
                .toLocaleLowerCase().replace("v", "");

            if(packageVersion != newVersion) {
                resultCb({type: 'newer', message: "发现新版本 " + newVersion + "，可前往 GitHub Release 页下载"})
                const updateNotify = notify("发现新版本", "发现新版本，请前往 GitHub Release 页下载");
                updateNotify.addListener('click', function(){
                    electron.shell.openExternal('https://github.com/RichieMay/electron-lark/releases')
                });

            } else {
                resultCb({type: 'latest', message: "当前已是最新版本"})
                if(showCheckNotify) notify("当前已是最新版本", "当前已是最新版本");
            }

            successCb();
        })
    });

    request.on('error', (e) => {
        if(finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        notifyCheckFail(e.message);
    });

    request.end();
}

module.exports = {
    checkInAppStart: checkUpdateInAppStart,
    startDailyCheck: startDailyUpdateCheck,
    check: checkUpdate,
}