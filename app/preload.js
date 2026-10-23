'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helperAPI', {
  getState: () => ipcRenderer.invoke('state:get'),
  getCatalog: () => ipcRenderer.invoke('catalog:list'),
  savePreciseConstants: values => ipcRenderer.invoke('constants:save', values),
  savePreciseDefaults: () => ipcRenderer.invoke('constants:set-default'),
  resetPreciseDefaults: () => ipcRenderer.invoke('constants:reset-default'),
  setNickname: value => ipcRenderer.invoke('nickname:set', value),
  getRecords: limit => ipcRenderer.invoke('records:list', limit),
  autoLocate: () => ipcRenderer.invoke('game:auto-locate'),
  chooseGame: () => ipcRenderer.invoke('game:choose'),
  refreshCatalog: () => ipcRenderer.invoke('game:refresh-catalog'),
  launchGame: () => ipcRenderer.invoke('game:launch'),
  selectAccount: key => ipcRenderer.invoke('account:select', key),
  updateSettings: patch => ipcRenderer.invoke('settings:update', patch),
  restartInput: () => ipcRenderer.invoke('input:restart'),
  revealArchive: () => ipcRenderer.invoke('archive:reveal'),
  saveExport: data => ipcRenderer.invoke('export:save', { data }),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  relaunchAdmin: () => ipcRenderer.invoke('app:relaunch-admin'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  onState: callback => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state-update', handler);
    return () => ipcRenderer.removeListener('state-update', handler);
  },
  onOverlayState: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('overlay-state', handler);
    return () => ipcRenderer.removeListener('overlay-state', handler);
  },
  onBackendEvent: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('backend-event', handler);
    return () => ipcRenderer.removeListener('backend-event', handler);
  }
});
