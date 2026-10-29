const appStoreFs = require("fs");
const path = require('path')
const electron = require('electron');
const Notification = electron.Notification;

const appConf = require("./configuration")

// 检查更新的时间间隔，每天只检查一次
const checkUpdateExpireTime = 3 * 24 * 60 * 60;

let updateCheckJson;

function getConfigJson(callback){
    if(appStoreFs == null) return
    appStoreFs.readFile('updateCheck.json','utf-8',function(err,data){
        if(err){
            console.log(err)
            console.log("读取json配置文件失败")
            updateCheckJson = {
                lastCheckUpdateTimeStamp: 0
            }
        }
        else{
            console.log("read config json:" + data);
            updateCheckJson = JSON.parse(data);
        }
        callback()
    });
}

function saveConfig(){
    if (appStoreFs == null) {
        console.log("fs 载入失败")
        return;
    }
    appStoreFs.writeFile("updateCheck.json",JSON.stringify(updateCheckJson, null, "  "),function (err) {
        if(err){
            console.log(err);
        }else{
            console.log("更新配置保存成功")
        }
    })
}

function checkUpdateInAppStart(){
    // localStorage.
    
    function check(){
        if(updateCheckJson == null){
            console.log("updateCheckJson 为 null")
            return
        } else {
            console.log(updateCheckJson)
        };
    
        
        let unixTimeStamp = Math.floor(new Date().getTime() / 1000);
        if(updateCheckJson.lastCheckUpdateTimeStamp == null){
            updateCheckJson.lastCheckUpdateTimeStamp = 0;
        } else {
            console.log("上次检查时间:" + updateCheckJson.lastCheckUpdateTimeStamp);
        }
    
        if(unixTimeStamp - updateCheckJson.lastCheckUpdateTimeStamp > checkUpdateExpireTime) {
            console.log("开始检查更新")
            checkUpdate(false, function(){
                updateCheckJson.lastCheckUpdateTimeStamp = unixTimeStamp;
                saveConfig();
            })    
        }
    }

    if(updateCheckJson == null){
        getConfigJson(function(){check()});
    } else {
        check();
    }

}

// 参数代表是否手动触发
function checkUpdate(showCheckNotify, successCb){
    if(successCb == undefined){
        successCb = function(){}
    }

    function notifyCheckFail(reason){
        console.log("检查更新失败: " + reason)
        if(showCheckNotify !== undefined && showCheckNotify) {
            new Notification({
                title: "检查更新失败",
                subtitle : "检查更新失败",
                body: reason,
                icon: electron.nativeImage.createFromPath(appConf.dock32),
            }).show();
        }
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
        console.log('request github api for check update, status code :' + response.statusCode);
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
                console.log("resJsonStr 校验错误")
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
            let packageVersion = require(path.join(__dirname, './../package.json'))
                .version
                .trim()
                .toLocaleLowerCase().replace("v", "");
            console.log("当前版本号:", packageVersion);
            console.log("最新版本号:", newVersion);

            if(packageVersion != newVersion) {
                let updateNotify = new Notification({
                    title: "发现新版本",
                    subtitle: "发现新版本",
                    body: "electron-lark 已发现新版本，请前往 github release 页下载",
                    icon: electron.nativeImage.createFromPath(appConf.dock32),
                });

                updateNotify.addListener('click', function(){
                    console.log("open github for download release");
                    electron.shell.openExternal('https://github.com/RichieMay/electron-lark/releases')
                });
                updateNotify.show();

            } else {
                if(showCheckNotify !== undefined && showCheckNotify) {
                    new Notification({
                        title: "当前已是最新版本",
                        subtitle: "当前已是最新版本",
                        body: "当前 elecron-lark 版本已是最新版本",
                        icon: electron.nativeImage.createFromPath(appConf.dock32),
                    }).show();
                }
            }

            successCb();
        })
    });

    request.on('error', (e) => {
        if(finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        console.log("fail in request github api")
        console.error(e);
        notifyCheckFail(e.message);
    });

    request.end();
}

module.exports = {
    checkInAppStart: checkUpdateInAppStart,
    check: checkUpdate,
}