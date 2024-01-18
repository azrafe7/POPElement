"use strict";

(async () => {
  
  const DEBUG = false;
  let debug = {
    log: DEBUG ? console.log.bind(console) : () => {} // log or NO_OP
  }

  let manifest = chrome.runtime.getManifest();
  console.log(manifest.name + " v" + manifest.version);

  const HIGHLIGHT_RED = "rgba(250, 70, 60, 0.5)";
  const HIGHLIGHT_GREEN = "rgba(17, 193, 12, 0.5)";
  const HIGHLIGHT_ORANGE = "rgba(255, 175, 12, 0.5)";
  const HIGHLIGHT_BLUE = "rgba(20, 80, 250, 0.5)";
  const HIGHLIGHT_BG_COLOR = HIGHLIGHT_BLUE;

  const OUTLINE_RED = "rgba(250, 70, 60, 0.75)";
  const OUTLINE_GREEN = "rgba(17, 193, 12, 0.90)";
  const OUTLINE_ORANGE = "rgba(255, 175, 0, 0.9)";
  const OUTLINE_BLUE = "rgba(20, 140, 200, 0.9)";
  const OUTLINE_COLOR = OUTLINE_BLUE;

  const CURSORS = ["crosshair", "copy"];

  let lastTriggeredElement = null;

  let pipWindow = null;

  /* if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    // dark mode
    HIGHLIGHT_BG_COLOR = HIGHLIGHT_DARK;
    OUTLINE_COLOR = OUTLINE_DARK;
  } */

  let options = {
    container: null,
    iFrameId: 'POP Element Picker Frame',
    enabled: false,
    selectors: "*",
    background: HIGHLIGHT_BG_COLOR,
    borderWidth: 0,
    outlineWidth: 1,
    outlineColor: OUTLINE_COLOR,
    transition: "",
    ignoreElements: [],
    action: {},
    hoverBoxInfoId: 'pop_picker_info',
  }

  let elementPicker = null;

  // close picker and set var to null
  function closePicker() {
    debug.log("[POPElement:CTX] closePicker()");
    if (elementPicker) {
      elementPicker.enabled = false;
      elementPicker.close();
      elementPicker = null;
    }
  }

  function addToPopWindow(target, options={}) {
    const defaults = { append:false };
    options = {...defaults, ...options};
    
    debug.log("[POPElement:CTX] target:", target);
    if (elementPicker) debug.log("[POPElement:CTX] info:", elementPicker.hoverInfo);
    lastTriggeredElement = target;
    
    const newPOPElement = {
      element: lastTriggeredElement, 
      container: lastTriggeredElement.parentElement, 
      nextElementSibling: lastTriggeredElement.nextElementSibling != elementPicker?.iframe ? lastTriggeredElement.nextElementSibling : null
    };
  }

  function createPicker() {
    debug.log("[POPElement:CTX] createPicker()");

    elementPicker = new ElementPicker(options);

    // elementPicker.hoverBox.style.cursor = CURSORS[0];
    elementPicker.action = {
      trigger: "mouseup",
      
      callback: ((event, target) => {
        debug.log("[POPElement:CTX] event:", event);
        let continuePicking = event.shiftKey;
        event.triggered = event.triggered ?? event.button == 0; // only proceed if left mouse button was pressed or "event.triggered" was set
        if (event.triggered) {
          addToPipWindow(target, { append: continuePicking });
        }
        
        elementPicker.enabled = continuePicking && event.triggered;
        
        if (!elementPicker.enabled) closePicker();
      })
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    debug.log("[POPElement:CTX]", msg);
    const { event, data } = msg;

    if (event === "togglePicker") {
      let enabled = elementPicker?.enabled ?? false;
      let toggledEnable = !enabled;
      if (toggledEnable) {
        createPicker();
        elementPicker.enabled = true;
        elementPicker.hoverBox.style.cursor = CURSORS[0];
      } else {
        closePicker();
      }
    } else if (event === "popOutPage") {
      if (elementPicker?.enabled) closePicker();
      chrome.runtime.sendMessage({event: 'popOutPage', data: null});
    } else if (event === 'checkState') {
      sendResponse({event: 'setState', data: { allowed:true }});
    }
  });

  const keyEventContainer = window; // elementPicker.iframe ? elementPicker.iframe : window;

  // close picker when pressing ESC
  keyEventContainer.addEventListener('keyup', function(e) {
    if (e.code === 'Escape' && elementPicker?.enabled) {
      closePicker();
      debug.log("[POPElement:CTX] user aborted");
    }
  }, true);

  keyEventContainer.addEventListener('keydown', function(e) {
    let target = null;
    let newTarget = null;
    let newTargetIdx = null;
    if (e.code === 'Space' && elementPicker?.enabled) {
      target = elementPicker.hoverInfo.element;
      debug.log("[POPElement:CTX] space-clicked target:", target);
      e.preventDefault();
      e.triggered = true; // checked inside action callback
      elementPicker.trigger(e);
    } else if (elementPicker?.enabled && (e.code === 'KeyQ' || e.code === 'KeyA')) {
      target = elementPicker.hoverInfo.element;

      let innermostTargetAtPoint = null; // first non-picker-iframe element
      for (let el of document.elementsFromPoint(elementPicker._lastClientX, elementPicker._lastClientY)) {
        if (el != elementPicker.iframe) {
          innermostTargetAtPoint = el;
          break;
        }
      }
      // build ancestors array
      let ancestorsAndSelf = [];
      for (let el=innermostTargetAtPoint; el != null; el = el.parentElement) {
        ancestorsAndSelf.push(el);
      }
      
      const ancestorsAndSelfLength = ancestorsAndSelf.length;
      const targetIdx = ancestorsAndSelf.indexOf(target);
      newTargetIdx = targetIdx;
      const targetHasNext = targetIdx <= (ancestorsAndSelfLength - 2);
      const targetHasPrev = targetIdx > 0;
      if (e.code === 'KeyQ' && targetHasNext) { // drill up
        newTargetIdx = targetIdx + 1;
        newTarget = ancestorsAndSelf[newTargetIdx];
        /*if (newTarget.contains(elementPicker.iframe)) {
          newTarget = target;
        }*/
        debug.log("[POPElement:CTX] Q-pressed new ↑ target:", newTarget);
      } else if (e.code === 'KeyA' && targetHasPrev) { // drill down
        newTargetIdx = targetIdx - 1;
        newTarget = ancestorsAndSelf[newTargetIdx];
        /*if (newTarget.contains(elementPicker.iframe)) {
          newTarget = target;
        }*/
        debug.log("[POPElement:CTX] A-pressed new ↓ target:", newTarget);
      }
      debug.log(`${newTargetIdx}/${ancestorsAndSelfLength - 1}`, 'newTarget', targetHasPrev, targetHasNext, newTarget, ancestorsAndSelf);
      if (newTarget && newTarget != target) {
        elementPicker.highlight(newTarget);
      }
      e.preventDefault();
    }
  }, true);

  // change picker cursor when holding SHIFT
  function updateCursor(eventInfo) {
    let {keyUp, event} = eventInfo;
    if (elementPicker?.enabled) {
      let cursorIdx = +event.shiftKey;
      if (elementPicker.hoverBox.style.cursor != CURSORS[cursorIdx]) {
        debug.log('[POPElement:CTX] change cursor to ' + CURSORS[cursorIdx]);
        elementPicker.hoverBox.style.cursor = CURSORS[cursorIdx];
      }
    }
  }
  
  keyEventContainer.addEventListener('keyup', (e) => updateCursor({keyUp: true, event: e}), true);
  keyEventContainer.addEventListener('keydown', (e) => updateCursor({keyUp: false, event: e}), true);

})();
