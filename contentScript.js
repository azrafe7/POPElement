"use strict";

(async () => {
  
  const DEBUG = true;
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

  let oldStylesByElement = new Map(); // ['element':[{'style':'name', 'value':'value', 'priority':'value'}]];

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

  function getAncestorsOf(el) {
    let ancestors = [];
    while (el && el.parentElement) {
      el = el.parentElement;
      ancestors.push(el);
    }
    return ancestors;
  }

  function getSiblingsOf(elements) {
    if (!elements.hasOwnProperty('length')) elements = [elements];
    let allSiblings = [];
    for (const el of elements) {
      if (el.parentElement) {
        let children = Array.from(el.parentElement.children);
        let siblings = children.filter((child) => child != el);
        allSiblings = allSiblings.concat(siblings);
      } else {
        let prevSibling = el.previousElementSibling;
        while (prevSibling) {
          allSiblings.push(prevSibling);
          prevSibling = el.previousElementSibling;
        }
        let nextSibling = el.nextElementSibling;
        while (nextSibling) {
          allSiblings.push(nextSibling);
          nextSibling = el.nextElementSibling;
        }
      }
    }
    
    return allSiblings;
  }

  function removeCSS() {    
    resetOldStyles(); // reset styles before removing classes
    
    const classes = ['--popped-element', '--non-popped-element', '--popped-element-ancestor'];
    const classesSelector = classes.map((c) => "." + c).join(",");
    const elements = document.querySelectorAll(classesSelector);
    const poppedElement = document.querySelector('.--popped-element');
    for (const el of elements) el.classList.remove(...classes);
    
    debug.log("scrollIntoView", poppedElement);
    if (poppedElement) {
      setTimeout(() => { // add a little delay before scrollIntoView
        poppedElement.scrollIntoView({ behavior: "smooth" });
      }, 100);
    }
  }

  function applyStylesTo(selector, styles) {
    let elements = Array.from(document.querySelectorAll(selector));
    for (const el of elements) {
      let stylesList = null;
      if (!oldStylesByElement.has(el)) {
        oldStylesByElement.set(el, []);
      }
      stylesList = oldStylesByElement.get(el);
      
      for (const style of styles) {
        let [styleName, styleValue] = Object.entries(style)[0];
        const oldStyleValue = el.style.getPropertyValue(styleName);
        const oldStylePriority = el.style.getPropertyPriority(styleName);
        stylesList.push({'style':styleName, 'value':oldStyleValue, 'priority':oldStylePriority});
        el.style.setProperty(styleName, styleValue, 'important');
      }
    }
  }
  
  function resetOldStyles() {
    for (const [el, stylesList] of oldStylesByElement.entries()) {
      for (const style of stylesList) {
        el.style.setProperty(style.style, style.value, style.priority);
      }
    }
    oldStylesByElement.clear();
  }

  function popWindow(target, options={}) {
    const defaults = { append:false };
    options = {...defaults, ...options};
    
    debug.log("[POPElement:CTX] target:", target);
    if (elementPicker) debug.log("[POPElement:CTX] info:", elementPicker.hoverInfo);
    lastTriggeredElement = target;
    
    let ancestors = getAncestorsOf(target);
    let ancestorsSiblings = getSiblingsOf([target].concat(ancestors));
    
    // add classes
    target.classList.add('--popped-element');
    for (const ancestor of ancestors) ancestor.classList.add('--popped-element-ancestor');
    for (const sibling of ancestorsSiblings) sibling.classList.add('--non-popped-element');
    
    // apply styles
    oldStylesByElement.clear();
    let elementsToStyleSelector = 'html, body';
    // applyStylesTo(elementsToStyleSelector, [{'overflow':'hidden'}]);
    
    applyStylesTo('.--popped-element-ancestor', [{ 'overflow':'hidden' }, { 'margin':'0' }, { 'padding':'0' }]);
    applyStylesTo('.--popped-element-ancestor', [{ 'display':'block' }]);
    applyStylesTo('.--non-popped-element', [{ 'display':'none' }, { 'visibility':'hidden' }]);
    // applyStylesTo('.--popped-element', [{ 'display':'block' }, { 'position':'fixed' }, { 'left':'0' }, { 'top':'0' }]);
    
    debug.log(oldStylesByElement);
    
    const size = { width:elementPicker.hoverInfo.width, height:elementPicker.hoverInfo.height };
    debug.log('popOutElement', size);
    chrome.runtime.sendMessage({ event:'popOutElement', data:size });
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
          popWindow(target, { append: continuePicking });
        }
        
        elementPicker.enabled = !event.triggered;
        
        closePicker();
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
    } else if (event === "removeCSS" || event === "popInPage") {
      removeCSS();
    } else if (event === "scrollIntoView") {
      if (lastTriggeredElement) {
        lastTriggeredElement.scrollIntoView({ behavior: "smooth" });
      }
      lastTriggeredElement = null;
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

})();
