// 桥接渲染进程与主进程
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    // 主进程 -> 渲染进程
    OnSysCall: (callback) => ipcRenderer.on('send-to-web', (_e, d) => callback(d)),
    OnError: (callback) => ipcRenderer.on('error-on-bg', (_e, d) => callback(d)),
    OnStartupOpenImage: (callback) => ipcRenderer.on('startup-open-image', (_e, p) => callback(p)),
    OnOpenImageFiles: (callback) => ipcRenderer.on('open-image-files', (_e, p) => callback(p)),
    OnImageSaved: (callback) => ipcRenderer.on('image-saved', (_e, p) => callback(p)),
    OnTrace: (callback) => ipcRenderer.on('trace', (_e, p) => callback(p)),
    OnAppLog: (callback) => ipcRenderer.on('app-log', (_e, msg) => callback(msg)),

    // 渲染进程 -> 主进程（单向）
    CallSys: (msg) => ipcRenderer.send('send-to-bgsys', msg),

    // 双向请求
    Invoke: (msg) => ipcRenderer.invoke('invoke', msg),
})