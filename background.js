"use strict";

const manifest = chrome.runtime.getManifest();
console.log(manifest.name + " v" + manifest.version);

const DEBUG = false; // shows the "Remove CSS..." entry in the action context menu
const INJECT_CSS = false; // inject/remove POPElement.css when popping out an element/re-attaching a page

// event names exchanged with contentScript.js (keep in sync)
const EVENTS = {
  POP_OUT_ELEMENT: 'popOutElement',
  POP_OUT_PAGE: 'popOutPage',
  POP_IN_PAGE: 'popInPage',
  REMOVE_CSS: 'removeCSS',
  TOGGLE_PICKER: 'togglePicker',
  SCROLL_INTO_VIEW: 'scrollIntoView',
  CHECK_STATE: 'checkState',
};

// keyboard shortcut names (declared in manifest.json, assignable in chrome://extensions/shortcuts)
const COMMANDS = {
  REATTACH: 'reattach-as-tab',
  TOGGLE_PICKER: 'toggle-element-picker',
};

const size = {
  width: 800,
  height: 600,
};

const offset = {
  top: 20,
  left: 20,
};

async function sendMessageToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch(error) {
    // e.g. no content script in that tab
    console.warn('Whoops...', error.message);
    return undefined;
  }
}

async function getActiveTab() {
  const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
  return activeTab;
}

// use the tab passed in by an event if it is valid, otherwise fall back to the active tab
async function resolveTab(tab) {
  return tab?.id > 0 ? tab : await getActiveTab();
}

// insert (or remove) POPElement.css in the given tab
async function injectCSS(tabId, insert=true) {
  const injection = {
    files: ['POPElement.css'],
    target: {
      tabId: tabId,
      allFrames: false
    }
  };
  try {
    if (insert) {
      await chrome.scripting.insertCSS(injection);
    } else {
      await chrome.scripting.removeCSS(injection);
    }
    console.log("css " + (insert ? "inserted" : "removed") + "!");
  } catch(error) {
    console.warn('Whoops...', error.message);
  }
}

// origin (window and index) of popped-out tabs: tabId -> { windowId, index, isElement, cloneId }
// (kept in memory and, if available, in chrome.storage.session, as the service worker may get suspended)
const ORIGINS_STORAGE_KEY = "POPElement_origins";
const originsByTabId = new Map();

async function loadOrigins() {
  try {
    const stored = await chrome.storage?.session?.get(ORIGINS_STORAGE_KEY);
    for (const [tabId, origin] of Object.entries(stored?.[ORIGINS_STORAGE_KEY] ?? {})) {
      if (!originsByTabId.has(Number(tabId))) originsByTabId.set(Number(tabId), origin);
    }
  } catch(error) {
    // storage permission not available: in-memory only
  }
}

async function saveOrigins() {
  try {
    await chrome.storage?.session?.set({ [ORIGINS_STORAGE_KEY]: Object.fromEntries(originsByTabId) });
  } catch(error) {
    // storage permission not available: in-memory only
  }
}

// loaded once at startup: always await before reading/writing origins
const originsReady = loadOrigins();

function rememberOrigin(tab, isElement=false) {
  originsByTabId.set(tab.id, { windowId:tab.windowId, index:tab.index, isElement:isElement });
  saveOrigins();
}

function setOriginCloneId(tabId, cloneId) {
  const origin = originsByTabId.get(tabId);
  if (!origin || cloneId == null) return;
  origin.cloneId = cloneId;
  saveOrigins();
}

function forgetOrigin(tabId) {
  if (originsByTabId.delete(tabId)) saveOrigins();
}

// don't let origins pile up when a popped-out tab gets closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await originsReady;
  forgetOrigin(tabId);
});

async function openPopupWindow(windowOptions, event) {
  const defaults = {
    type: 'popup',
    width: size.width,
    height: size.height,
    top: offset.top,
    left: offset.left,
    //setSelfAsOpener: true,
  };
  windowOptions = { ...defaults, ...windowOptions };

  await originsReady;
  const tab = await chrome.tabs.get(windowOptions.tabId);
  if (tab.incognito) windowOptions.incognito = true;
  // remember where the tab came from, so it can be re-attached at the same place
  rememberOrigin(tab, event === EVENTS.POP_OUT_ELEMENT);
  if (event === EVENTS.POP_OUT_ELEMENT) {
    const clonedTab = await chrome.tabs.duplicate(windowOptions.tabId);
    // remember the clone (it stays in the source window), so the element can be re-attached just after it
    setOriginCloneId(windowOptions.tabId, clonedTab?.id);
  }
  chrome.windows.create(windowOptions, (win) => {
    console.log('created', win, 'tab', windowOptions?.tabId);
  });
}

// find the window the tab originally came from (if it still exists and is compatible)
async function getOriginWindow(tab, origin) {
  if (!origin) return null;
  try {
    const win = await chrome.windows.get(origin.windowId, { populate:true });
    if (win.type === 'normal' && win.incognito == tab.incognito) return win;
  } catch(error) {
    // original window no longer exists
  }
  return null;
}

// window to use when the original one is not available
async function getFallbackWindow(tab) {
  const windowFilter = { windowTypes:['normal'] };
  let win = null;
  try {
    win = await chrome.windows.getLastFocused(windowFilter);
    if (win.incognito != tab.incognito) win = null;
  } catch(error) {
    // no last-focused window
    win = null;
  }
  const allWindows = await chrome.windows.getAll(windowFilter);
  console.log('last win', win, allWindows);
  if (!win) {
    const filteredWindows = allWindows.filter((w) => w.incognito == tab.incognito);
    if (filteredWindows.length > 0) {
      win = filteredWindows[filteredWindows.length - 1];
    } else {
      win = await chrome.windows.create({ tabId:tab.id, incognito:tab.incognito });
    }
  }
  return win;
}

// index at which a tab should be re-attached to its original window
async function getOriginIndex(origin, win) {
  const tabCount = win.tabs?.length;
  // keep the original index (limited to the number of tabs now in that window)
  let index = Math.min(origin.index, tabCount ?? origin.index);

  if (origin.isElement) {
    // an element goes just after its source tab (the clone left behind when popping out)
    let sourceTab = null;
    try {
      if (origin.cloneId != null) sourceTab = await chrome.tabs.get(origin.cloneId);
    } catch(error) {
      // clone tab no longer exists
    }
    if (sourceTab && sourceTab.windowId === win.id) {
      index = sourceTab.index + 1;
    } else {
      // source tab is gone: use the original index (the clone took its place)
      index = origin.index + 1;
    }
    index = Math.min(index, tabCount ?? index);
  }
  return index;
}

async function reattachTab(tab) {
  await originsReady;
  const origin = originsByTabId.get(tab.id);
  let win = await getOriginWindow(tab, origin); // prefer the original window
  let index = -1;
  if (win) {
    index = await getOriginIndex(origin, win);
  } else {
    win = await getFallbackWindow(tab);
  }

  const reattachedTab = await chrome.tabs.move(tab.id, { windowId:win.id, index:index });
  forgetOrigin(tab.id);
  await chrome.windows.update(win.id, { focused:true });
  chrome.tabs.update(reattachedTab.id, { active:true });
  updateContextMenu({reattach:false});
}

// re-attach a popped-out tab (used by context menu and keyboard shortcut)
async function handleReattach(tab) {
  await originsReady;
  // a popped-out element keeps its styles/classes, only a full page gets cleaned up
  const isElement = originsByTabId.get(tab.id)?.isElement ?? false;
  await reattachTab(tab);
  if (!isElement) {
    if (INJECT_CSS) injectCSS(tab.id, false);
    sendMessageToTab(tab.id, { event:EVENTS.POP_IN_PAGE, data:null });
  }
}

// add/remove contextMenu entry
const otherContexts = ["page", "frame", "selection", "link", "editable", "image", "video", "audio"]; // all but "action" context
const actionContext = ["action"]; // only "action" context
const POPPickerContextId = "POPElement_onTogglePickerContextMenu";
const POPRemoveCSSContextId = "POPElement_onRemoveCSSContextMenu";
const POPReattachContextId = "POPElement_onReattachContextMenu";

function createMenuItem(id, title, contexts) {
  chrome.contextMenus.create({ id, title, contexts }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Whoops...', chrome.runtime.lastError.message);
    }
  });
}

// the menu is only rebuilt when its state changes, and rebuilds are queued so they can't overlap
let contextMenuState = null;
let contextMenuQueue = Promise.resolve();
function updateContextMenu(options={}) {
  const defaults = { picker:true, reattach:false };
  options = { ...defaults, ...options };

  const state = `${options.picker}:${options.reattach}`;
  if (state === contextMenuState) return contextMenuQueue;
  contextMenuState = state;

  contextMenuQueue = contextMenuQueue.then(async () => {
    await chrome.contextMenus.removeAll();
    // remove CSS (debug)
    if (DEBUG) {
      createMenuItem(POPRemoveCSSContextId, "Remove CSS...", actionContext);
    }
    // toggle picker
    if (options.picker) {
      createMenuItem(POPPickerContextId, "Toggle element picker...", actionContext);
    }
    // re-attach as tab
    if (options.reattach) {
      createMenuItem(POPReattachContextId, "Re-attach as tab...", otherContexts);
    }
  }).catch((error) => {
    console.warn('Whoops...', error.message);
    contextMenuState = null; // force a rebuild next time
  });
  return contextMenuQueue;
}

// react to clicking the browser action
chrome.action.onClicked.addListener(async (tab) => {
  console.log("[POPElement:BG] onClicked");
  openPopupWindow({ tabId:tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[POPElement:BG]", msg);
  const { event, data } = msg;

  if (event === EVENTS.POP_OUT_ELEMENT) {
    const tabId = sender.tab.id;
    const elementSize = { width:parseInt(data.elementSize.width), height:parseInt(data.elementSize.height) + 40 };
    const screenAvailSize = { width:parseInt(data.screenAvailSize.width), height:parseInt(data.screenAvailSize.height) };
    console.log('screenAvailSize', screenAvailSize);
    const windowOptions = { tabId:tabId, ...elementSize };
    if (INJECT_CSS) injectCSS(tabId, true);
    console.log('popOutElement', windowOptions);
    openPopupWindow(windowOptions, event);
    sendMessageToTab(tabId, { event:EVENTS.SCROLL_INTO_VIEW, data:null });
  } else if (event === EVENTS.POP_OUT_PAGE) {
    openPopupWindow({ tabId:sender.tab.id }, event);
  }
});

// keyboard shortcuts (assignable in chrome://extensions/shortcuts)
chrome.commands.onCommand.addListener(async (command, tab) => {
  console.log("[POPElement:BG] onCommand:", command, tab);
  if (!Object.values(COMMANDS).includes(command)) return;

  tab = await resolveTab(tab);
  if (!(tab?.id > 0)) {
    console.warn(`[POPElement:BG] Whoops... No valid tab.id found.`);
    return;
  }

  if (command === COMMANDS.TOGGLE_PICKER) {
    sendMessageToTab(tab.id, { event:EVENTS.TOGGLE_PICKER, data:null });
  } else if (command === COMMANDS.REATTACH) {
    // only popped-out (popup type) windows can be re-attached
    const win = await chrome.windows.get(tab.windowId);
    if (win?.type !== 'popup') {
      console.log("[POPElement:BG] not a popup window, nothing to re-attach");
      return;
    }
    handleReattach(tab);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  console.log("[POPElement:BG] onContextMenuClicked:", [info, tab]);

  tab = await resolveTab(tab);
  if (!(tab?.id > 0)) {
    console.warn(`[POPElement:BG] Whoops... No valid tab.id found.`);
    return;
  }

  if (info.menuItemId === POPPickerContextId) {
    console.log("[POPElement:BG] toggling element picker...");
    sendMessageToTab(tab.id, { event:EVENTS.TOGGLE_PICKER, data:null });
  } else if (info.menuItemId === POPReattachContextId) {
    console.log("[POPElement:BG] re-attach as tab...", tab.id);
    handleReattach(tab);
  } else if (info.menuItemId === POPRemoveCSSContextId) {
    console.log("[POPElement:BG] remove CSS...", tab.id);
    injectCSS(tab.id, false);
    sendMessageToTab(tab.id, { event:EVENTS.REMOVE_CSS, data:null });
  }
});

// ask the content script of a tab if the extension is allowed there and update the UI accordingly
// (no answer, e.g. on pages without content script, means "not allowed")
async function checkState(tabId=null) {
  tabId ??= (await getActiveTab())?.id;
  console.log('checkState for tabId', tabId);
  if (!tabId) return;

  const response = await sendMessageToTab(tabId, { event:EVENTS.CHECK_STATE, data:null });
  setState(response?.data?.allowed ?? false, tabId);
}

async function setState(allowed, tabId=null) {
  const activeTab = await getActiveTab();
  tabId ??= activeTab?.id;
  if (!tabId) return;
  console.log('setState', allowed, 'tabId', tabId);

  let actionTitle = `${manifest.action.default_title} v${manifest.version}`;
  if (!allowed) actionTitle += ' (DISABLED for this site)';
  chrome.action.setTitle({tabId: tabId, title: actionTitle});
  if (allowed) {
    chrome.action.enable(tabId);
  } else {
    chrome.action.disable(tabId);
  }

  // the context menu is global: only update it for the tab the user is looking at
  if (tabId === activeTab?.id) {
    const currWindow = await chrome.windows.getCurrent();
    const showReattach = currWindow?.type === 'popup';
    updateContextMenu({picker:allowed, reattach:showReattach});
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // onUpdated fires many times while loading: only check once the page is done
  if (changeInfo.status !== 'complete') return;
  console.log("onUpdated tab", tab);
  checkState(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  console.log("onActivated activeInfo", activeInfo);
  checkState(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  console.log("onFocusChanged", windowId);
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // all Chrome windows lost focus
  checkState();
});

checkState();
