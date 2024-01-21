"use strict";

let manifest = chrome.runtime.getManifest();
console.log(manifest.name + " v" + manifest.version);

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

function openPopupWindow(options) {
  const defaults = {
    type: 'popup',
    width: size.width,
    height: size.height,
    top: offset.top,
    left: offset.left,
    setSelfAsOpener:true,
  };
  options = { ...defaults, ...options };

  chrome.windows.create(options, (win) => {
    console.log('created', win, 'tab', options?.tabId);
  });
}


async function reattachTab(tab) {
  const options = { windowTypes:['normal'] };
  let win = null;
  try {
    win = await chrome.windows.getLastFocused(options);
  } catch(error) {
    // no last-focused window
    win = null;
  }
  let allWindows = await chrome.windows.getAll(options);
  console.log('last win', win, allWindows);
  if (!win) {
    if (allWindows?.length > 0) {
      win = allWindows[allWindows.length - 1];
    } else {
      win = await chrome.windows.create({ tabId:tab.id });
    }
  }
  
  let reattachedTab = await chrome.tabs.move(tab.id, { windowId:win.id, index:-1 });
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
      if (true) {
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
    const elementSize = { width:parseInt(data.width), height:parseInt(data.height) + 40 };
    let options = { tabId:tabId, ...elementSize};
    // injectCSS(tabId, true);
    // openPopupWindow(options);
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
      reattachTab(tab);
      injectCSS(tab.id, false);
      sendMessageToTab(
        tab.id,
        {
          event: "popInPage",
          data: null,
        }
      );
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
    chrome.action.setIcon({ path:'assets/icon128_popped.png' });
    chrome.action.setTitle({tabId: tabId, title: actionTitle});
    chrome.action.disable(tabId);
    updateContextMenu({picker:allowed, reattach:showReattach});
  } else {
    chrome.action.setIcon({ path:'assets/icon128.png' });
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
