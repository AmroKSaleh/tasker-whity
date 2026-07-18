const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tasker', {
  listProjects: () => ipcRenderer.invoke('registry:list'),
  addProject: () => ipcRenderer.invoke('registry:add'),
  removeProject: (root) => ipcRenderer.invoke('registry:remove', root),
  readProject: (root) => ipcRenderer.invoke('project:read', root),
  watchProject: (root) => ipcRenderer.invoke('project:watch', root),
  onProjectChanged: (cb) => {
    ipcRenderer.on('project-changed', (_e, root) => cb(root));
  },
});
