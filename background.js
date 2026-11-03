"use strict";

let manifest = chrome.runtime.getManifest();
console.log(manifest.name + " v" + manifest.version);

let DEBUG = false;
let INJECT_CSS = false;

let size = {
  width: 800,
  height: 600,
};

let offset = {
  top: 20,
  left: 20,
};

async function sendMessageToTab(tabId, msg) {
  return chrome.tabs.sendMessage(
    tabId,
    msg,
    (response) => {
      let lastError = chrome.runtime.lastError;
      if (lastError) {
        console.warn('Whoops...', lastError.message);
      }
    }
  );
}

async function openPopupWindow(options, event) {
  const defaults = {
    type: 'popup',
    width: size.width,
    height: size.height,
    top: offset.top,
    left: offset.left,
    //setSelfAsOpener: true,
  };
  options = { ...defaults, ...options };

  let tab = await chrome.tabs.get(options.tabId);
  if (tab.incognito) options.incognito = true;
  // remember where the tab came from, so it can be re-attached at the same place
  rememberOrigin(tab, event === "popOutElement");
  if (event === "popOutElement") {
    let clonedTab = await chrome.tabs.duplicate(options.tabId);
    // remember the clone (it stays in the source window), so the element can be re-attached just after it
    setOriginCloneId(options.tabId, clonedTab?.id);
  }
  chrome.windows.create(options, (win) => {
    console.log('created', win, 'tab', options?.tabId);
  });
}


// origin (window and index) of popped-out tabs: tabId -> { windowId, index, isElement }
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
  originsByTabId.delete(tabId);
  saveOrigins();
}

// find the window the tab originally came from (if it still exists and is compatible)
async function getOriginWindow(tab, origin) {
  if (!origin) return null;
  try {
    let win = await chrome.windows.get(origin.windowId, { populate:true });
    if (win.type === 'normal' && win.incognito == tab.incognito) return win;
  } catch(error) {
    // original window no longer exists
  }
  return null;
}

async function reattachTab(tab) {
  await loadOrigins();
  const origin = originsByTabId.get(tab.id);
  const options = { windowTypes:['normal'] };
  let win = await getOriginWindow(tab, origin); // prefer the original window
  let index = -1;
  if (win) {
    // keep the original index (limited to the number of tabs now in that window)
    index = Math.min(origin.index, win.tabs?.length ?? origin.index);
    
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
      index = Math.min(index, win.tabs?.length ?? index);
    }
  }
  try {
    if (!win) win = await chrome.windows.getLastFocused(options);
    if (win.incognito != tab.incognito) win = null;
  } catch(error) {
    // no last-focused window
    win = null;
  }
  let allWindows = await chrome.windows.getAll(options);
  console.log('last win', win, allWindows);
  if (!win) {
    let filteredWindows = allWindows.filter((w) => w.incognito == tab.incognito);
    if (filteredWindows?.length > 0) {
      win = filteredWindows[filteredWindows.length - 1];
    } else {
      win = await chrome.windows.create({ tabId:tab.id, incognito:tab.incognito });
    }
  }
  
  let reattachedTab = await chrome.tabs.move(tab.id, { windowId:win.id, index:index });
  forgetOrigin(tab.id);
  await chrome.windows.update(win.id, { focused:true });
  chrome.tabs.update(reattachedTab.id, { active:true });
  updateContextMenu({reattach:false});
}

// add/remove contextMenu entry
const otherContexts = ["page", "frame", "selection", "link", "editable", "image", "video", "audio"]; // all but "action" context
const actionContext = ["action"]; // only "action" context
const POPPickerContextId = "POPElement_onTogglePickerContextMenu";
const POPRemoveCSSContextId = "POPElement_onRemoveCSSContextMenu";
const POPReattachContextId = "POPElement_onReattachContextMenu";
function updateContextMenu(options={}) {
  const defaults = { picker:true, reattach:false };
  options = { ...defaults, ...options };
  chrome.contextMenus.removeAll(function() {
    // console.log("remove");
    if (chrome.runtime.lastError) {
      console.warn('Whoops...', chrome.runtime.lastError.message);
    } else {
      
      // remove CSS (debug)
      if (DEBUG) {
        chrome.contextMenus.create({
          id: POPRemoveCSSContextId,
          title: "Remove CSS...",
          contexts: actionContext,
        }, () => {
          // console.log("create");
          if (chrome.runtime.lastError) {
            console.warn('Whoops...', chrome.runtime.lastError.message);
          }      
        });
      }
      
      // toggle picker
      if (options.picker) {
        chrome.contextMenus.create({
          id: POPPickerContextId,
          title: "Toggle element picker...",
          contexts: actionContext,
        }, () => {
          // console.log("create");
          if (chrome.runtime.lastError) {
            console.warn('Whoops...', chrome.runtime.lastError.message);
          }      
        });
      }
      
      // re-attach as tab
      if (options.reattach) {
        chrome.contextMenus.create({
          id: POPReattachContextId,
          title: "Re-attach as tab...",
          contexts: otherContexts,
        }, () => {
          // console.log("create");
          if (chrome.runtime.lastError) {
            console.warn('Whoops...', chrome.runtime.lastError.message);
          }      
        });
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // updateContextMenu({enable:true});
});

// reacto to clicking the browser action
chrome.action.onClicked.addListener(async (tab) => {
  console.log("[POPElement:BG] onClicked");

  let options = { tabId:tab.id };
  openPopupWindow(options);
  /*chrome.tabs.sendMessage(
    tab.id,
    {
      event: "popOutPage",
      data: null,
    }
  );*/
});

function injectCSS(tabId, insert=true) {
  let insertOrRemoveFunc = insert ? chrome.scripting.insertCSS : chrome.scripting.removeCSS;
  insertOrRemoveFunc(
    {
      files: ['POPElement.css'],
      target:
        {
          tabId: tabId,
          allFrames: false
        }
    },
    () => {
      console.log("css " + (insert ? "inserted" : "removed") + "!");
    }
  );
}

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  console.log("[POPElement:BG]", msg);
  const { event, data } = msg;

  if (event === 'popOutElement') {
    const tabId = sender.tab.id;
    const elementSize = { width:parseInt(data.elementSize.width), height:parseInt(data.elementSize.height) + 40 };
    const screenAvailSize = { width:parseInt(data.screenAvailSize.width), height:parseInt(data.screenAvailSize.height) };
    console.log('screenAvailSize', screenAvailSize);
    let responseData = null;
    let options = { tabId:tabId, ...elementSize};
    if (INJECT_CSS) injectCSS(tabId, true);
    console.log('popOutElement', options);
    openPopupWindow(options, event);
    sendMessageToTab(
      tabId,
      {
        event: "scrollIntoView",
        data: responseData,
      }
    );
  } else if (event === 'popOutPage') {
    let options = { tabId:sender.tab.id };
    openPopupWindow(options, event);
  }
});

// re-attach a popped-out tab (used by context menu and keyboard shortcut)
async function handleReattach(tab) {
  await loadOrigins();
  // a popped-out element keeps its injected CSS/styles, only a full page gets cleaned up
  const isElement = originsByTabId.get(tab.id)?.isElement ?? false;
  await reattachTab(tab);
  if (!isElement) {
    injectCSS(tab.id, false);
    sendMessageToTab(
      tab.id,
      {
        event: "popInPage",
        data: null,
      }
    );
  }
}

// keyboard shortcut (assignable in chrome://extensions/shortcuts)
chrome.commands.onCommand.addListener(async (command, tab) => {
  console.log("[POPElement:BG] onCommand:", command, tab);
  if (!["reattach-as-tab", "toggle-element-picker"].includes(command)) return;

  if (!tab?.id) {
    [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  }
  if (!tab?.id) {
    console.warn(`[POPElement:BG] Whoops... No valid tab.id found.`);
    return;
  }

  if (command === "toggle-element-picker") {
    sendMessageToTab(
      tab.id,
      {
        event: "togglePicker",
        data: null,
      }
    );
  } else if (command === "reattach-as-tab") {
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

  const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab.id <= 0) {
    console.log("[POPElement:BG] tabId <= 0:", tab.id, activeTab);
    tab.id = activeTab?.id;
  }
  if (tab.id <= 0) {
    console.warn(`[POPElement:BG] Whoops... No valid tab.id found.`);
  } else {
  
    if (info.menuItemId === POPPickerContextId) {
      console.log("[POPElement:BG] opening page in Popped-Out-Page...");
      sendMessageToTab(
        tab.id,
        {
          event: "togglePicker",
          data: null,
        }
      );
    } else if (info.menuItemId === POPReattachContextId) {
      console.log("[POPElement:BG] re-attach as tab...", tab.id);
      handleReattach(tab);
    } else if (info.menuItemId === POPRemoveCSSContextId) {
      console.log("[POPElement:BG] remove CSS...", tab.id);
      // reattachTab(tab);
      injectCSS(tab.id, false);
      sendMessageToTab(
        tab.id,
        {
          event: "removeCSS",
          data: null,
        }
      );
    }
  }
});


async function checkState(tabId=null) {
  if (tabId == null) {
    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    tabId = activeTab?.id;
  }
  console.log('checkState for tabId', tabId);
  if (!tabId) return;
  
  chrome.tabs.sendMessage(
    tabId,
    {
      event: "checkState",
      data: null
    },
    (msg) => {
      if (chrome.runtime.lastError) {
        console.warn('Whoops...', chrome.runtime.lastError.message);
      } else {
        const { event, data } = msg;
        setState(data.allowed, tabId);
      }
    }
  );
}

async function setState(allowed, tabId=null) {
  if (tabId == null) {
    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    tabId = activeTab?.id;
    if (!tabId) return;
  }
  console.log('setState', allowed, 'tabId', tabId);
  
  let actionTitle = `${manifest.action.default_title} v${manifest.version}`;
  chrome.action.setTitle({tabId: tabId, title: actionTitle});
  const currWindow = await chrome.windows.getCurrent();
  const showReattach = currWindow?.type === 'popup';
  
  if (!allowed) {
    actionTitle = actionTitle + ' (DISABLED for this site)';
    // chrome.action.setIcon({ path:'assets/icon128_popped.png' });
    chrome.action.setTitle({tabId: tabId, title: actionTitle});
    chrome.action.disable(tabId);
    updateContextMenu({picker:allowed, reattach:showReattach});
  } else {
    // chrome.action.setIcon({ path:'assets/icon128.png' });
    chrome.action.setTitle({tabId: tabId, title: actionTitle});
    chrome.action.enable(tabId);
    updateContextMenu({picker:allowed, reattach:showReattach});
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  console.log("onUpdated tab", tab);

  setState(false);
  checkState(tabId);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  let [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
  console.log("onActivated activeInfo", activeInfo);

  setState(false);
  checkState(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  let [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
  console.log("onFocusChanged", windowId, activeTab);
  
  if (activeTab?.id) {
    checkState(activeTab.id);
  }
});

setState(false);
checkState();
