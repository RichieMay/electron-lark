const appStoreFs = require("fs");
const path = require('path')
const electron = require('electron');

// Release 页地址与"发现新版本"文案的单一来源：
// 静默检查(启动/每日)与手动检查(设置页)共用，改文案只动这里。
// 本模块只负责检查并经 resultCb 上报结果，展示(系统通知/toast 兜底)
// 统一在 main.js 完成
const RELEASE_PAGE_URL = 'https://github.com/RichieMay/electron-lark/releases'

function newerVersionCopy(version) {
    return {
        title: "发现新版本 " + version,
        body: "点击前往下载",
    }
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

function checkUpdateInAppStart(resultCb){
    function check(){
        if(updateCheckJson == null) return

        const unixTimeStamp = Math.floor(new Date().getTime() / 1000);
        if(updateCheckJson.lastCheckUpdateTimeStamp == null){
            updateCheckJson.lastCheckUpdateTimeStamp = 0;
        }

        // 每次启动都静默检查。结果经 resultCb 交给调用方展示：
        // 静默路径只对"发现新版本"出提示，latest/fail 不打扰
        checkUpdate(function(){
            updateCheckJson.lastCheckUpdateTimeStamp = unixTimeStamp;
            saveConfig();
        }, function(result){
            if(result.type === 'newer' && typeof resultCb === 'function') resultCb(result)
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

function startDailyUpdateCheck(resultCb){
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
            checkUpdate(function(){
                if(updateCheckJson != null){
                    updateCheckJson.lastCheckUpdateTimeStamp = Math.floor(new Date().getTime() / 1000);
                    saveConfig();
                }
            }, function(result){
                // 静默路径只对"发现新版本"出提示
                if(result.type === 'newer' && typeof resultCb === 'function') resultCb(result)
            });
            // 检查完排下一天
            scheduleNext();
        }, next.getTime() - now.getTime());
    }

    scheduleNext();
}

// 参数: successCb 完成回调(可空);
//       resultCb 结果回调({type: newer/latest/fail, version, message})，
//       展示统一在 main.js（系统通知，不可用时落 toast）
function checkUpdate(successCb, resultCb){
    if(successCb == undefined){
        successCb = function(){}
    }
    if(resultCb == undefined){
        resultCb = function(){}
    }

    function notifyCheckFail(reason){
        console.log("检查更新失败: " + reason)
        resultCb({type: 'fail', message: reason})
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
                const copy = newerVersionCopy(newVersion)
                resultCb({type: 'newer', version: newVersion, message: copy.title + "，" + copy.body})

            } else {
                resultCb({type: 'latest', message: "当前已是最新版本"})
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
    RELEASE_PAGE_URL: RELEASE_PAGE_URL,
    newerVersionCopy: newerVersionCopy,
}
