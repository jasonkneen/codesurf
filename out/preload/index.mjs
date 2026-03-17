import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("electron", {
  // Workspace operations
  workspace: {
    list: () => ipcRenderer.invoke("workspace:list"),
    create: (name) => ipcRenderer.invoke("workspace:create", name),
    delete: (id) => ipcRenderer.invoke("workspace:delete", id),
    setActive: (id) => ipcRenderer.invoke("workspace:setActive", id),
    getActive: () => ipcRenderer.invoke("workspace:getActive")
  },
  // File system operations
  fs: {
    readDir: (path) => ipcRenderer.invoke("fs:readDir", path),
    readFile: (path) => ipcRenderer.invoke("fs:readFile", path),
    writeFile: (path, content) => ipcRenderer.invoke("fs:writeFile", path, content),
    createFile: (path) => ipcRenderer.invoke("fs:createFile", path),
    deleteFile: (path) => ipcRenderer.invoke("fs:deleteFile", path),
    renameFile: (oldPath, newPath) => ipcRenderer.invoke("fs:renameFile", oldPath, newPath),
    watch: (path, callback) => {
      const channel = `fs:watch:${path}`;
      ipcRenderer.on(channel, (_, event, filename) => callback(event, filename));
      return () => ipcRenderer.removeAllListeners(channel);
    }
  },
  // Canvas state persistence
  canvas: {
    load: (workspaceId) => ipcRenderer.invoke("canvas:load", workspaceId),
    save: (workspaceId, state) => ipcRenderer.invoke("canvas:save", workspaceId, state)
  },
  // Terminal operations (stub for now)
  terminal: {
    create: (tileId, workspaceId) => ipcRenderer.invoke("terminal:create", tileId, workspaceId),
    write: (tileId, data) => ipcRenderer.invoke("terminal:write", tileId, data),
    resize: (tileId, cols, rows) => ipcRenderer.invoke("terminal:resize", tileId, rows, cols),
    destroy: (tileId) => ipcRenderer.invoke("terminal:destroy", tileId),
    onData: (tileId, callback) => {
      const channel = `terminal:data:${tileId}`;
      ipcRenderer.on(channel, (_, data) => callback(data));
      return () => ipcRenderer.removeAllListeners(channel);
    }
  },
  // Update checker (stub)
  updater: {
    check: () => ipcRenderer.invoke("updater:check"),
    download: () => ipcRenderer.invoke("updater:download")
  }
});
