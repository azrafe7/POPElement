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

  const scrollIntoViewOptions = { behavior:"smooth", block:"center", inline:"center" };

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
    
    debug.log("[POPElement:CTX] scrollIntoView", poppedElement);
    if (poppedElement) {
      setTimeout(() => { // add a little delay before scrollIntoView
        poppedElement.scrollIntoView(scrollIntoViewOptions);
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
    
    // popOutPage if target is the root element
    if (target.parentElement == null) {
      chrome.runtime.sendMessage({event: 'popOutPage', data: null});
      return;
    }
    
    let ancestors = getAncestorsOf(target);
    let ancestorsSiblings = getSiblingsOf([target].concat(ancestors));
    
    // add classes
    target.classList.add('--popped-element');
    for (const ancestor of ancestors) ancestor.classList.add('--popped-element-ancestor');
    for (const sibling of ancestorsSiblings) sibling.classList.add('--non-popped-element');
    let parentElement = ancestors.length >= 1 ? ancestors[0] : null;
    if (parentElement) {
      parentElement.classList.add('--popped-element-parent');
    }
    
    debug.log('[POPElement:CTX] ancestors:', ancestors);
    debug.log('[POPElement:CTX] ancestorsSiblings:', ancestorsSiblings);
    
    let ancestorsPosition = ancestors.map((el) => ({ el:el, position:getComputedStyle(el)['position'] }));
    debug.log('[POPElement:CTX] ancestorsPosition:', ancestorsPosition);
    
    // apply styles
    oldStylesByElement.clear();    
    const elementSize = { width:elementPicker.hoverInfo.width, height:elementPicker.hoverInfo.height };
    const screenAvailSize = { width: window.screen.availWidth, height: window.screen.availHeight };

    const ancestorOverflowX = {'overflow-x':'hidden'};
    const ancestorOverflowY = {'overflow-y':'hidden'};
    if (elementSize.width > screenAvailSize.width) {
      elementSize.width = screenAvailSize.width;
      ancestorOverflowX['overflow-x'] = 'auto';
    }
    if (elementSize.height > screenAvailSize.height) {
      elementSize.height = screenAvailSize.height;
      ancestorOverflowY['overflow-y'] = 'auto';
    }

    applyStylesTo('.--popped-element-ancestor', [ancestorOverflowX, ancestorOverflowY, { 'margin':'0' }, { 'padding':'0' }]);
    applyStylesTo('.--popped-element-ancestor', [{ 'display':'block' }]);
    applyStylesTo('.--non-popped-element', [{ 'display':'none' }, { 'visibility':'hidden' }]);
    if (parentElement && getComputedStyle(parentElement)['position'] === 'relative') {
      applyStylesTo('.--popped-element-parent', [{ 'position':'fixed' }]);
    }
    // applyStylesTo('.--popped-element', [{ 'display':'block' }, { 'position':'fixed' }, { 'left':'0' }, { 'top':'0' }]);
    
    debug.log("[POPElement:CTX] oldStylesByElement:", oldStylesByElement);
    
    let data = { elementSize:elementSize, screenAvailSize:screenAvailSize };
    debug.log('[POPElement:CTX] popOutElement:', data);
    chrome.runtime.sendMessage({ event:'popOutElement', data });
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
    debug.log("[POPElement:CTX] onMessage:", msg);
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
      //removeCSS();
    } else if (event === "scrollIntoView") {
      if (lastTriggeredElement) {
        lastTriggeredElement.scrollIntoView(scrollIntoViewOptions);
      }
      lastTriggeredElement = null;
    } else if (event === 'checkState') {
      sendResponse({event: 'setState', data: { allowed:true }});
    }
  });

  const keyEventContainer = window; // elementPicker.iframe ? elementPicker.iframe : window;

  // close picker when pressing ESC
  keyEventContainer.addEventListener('keyup', function(e) {
    if (elementPicker?.enabled && ['Escape', 'Space', 'KeyA', 'KeyQ'].includes(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (e.code === 'Escape' && elementPicker?.enabled) {
      closePicker();
      debug.log("[POPElement:CTX] user aborted");
    }
  }, true);

  keyEventContainer.addEventListener('keydown', function(e) {
    if (elementPicker?.enabled && ['Escape', 'Space', 'KeyA', 'KeyQ'].includes(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    let target = null;
    let newTarget = null;
    let newTargetIdx = null;
    if (e.code === 'Space' && elementPicker?.enabled) {
      target = elementPicker.hoverInfo.element;
      debug.log("[POPElement:CTX] space-clicked target:", target);
      e.triggered = true; // checked inside action callback
      elementPicker.trigger(e);
    } else if (elementPicker?.enabled && (e.code === 'KeyQ' || e.code === 'KeyA')) {
      target = elementPicker.hoverInfo.element;

      // temporarily set pointer-events:all for all videos
      // (as pointer-events:none will prevent elements to be returned by elementsFromPoint())
      let videos = Array.from(document.querySelectorAll('video'));
      let fixedVideosMap = new Map(); // [element: { prop, value, priority }]
      const POINTER_EVENTS = 'pointer-events';
      for (let video of videos) {
        let computedStyle = getComputedStyle(video);
        // console.log('video:', video, 'computedStyle', POINTER_EVENTS + ':', computedStyle[POINTER_EVENTS]);
        if (computedStyle[POINTER_EVENTS] === 'none') {
          let value = video.style.getPropertyValue(POINTER_EVENTS);
          let priority = video.style.getPropertyPriority(POINTER_EVENTS);
          fixedVideosMap.set(video, { prop:POINTER_EVENTS, value:value, priority:priority });
          video.style.setProperty(POINTER_EVENTS, 'all', 'important');
        }
      }
      debug.log(`[POPElement:CTX] fixedVideosMap (${fixedVideosMap}):`, fixedVideosMap)
      
      let innermostTargetAtPoint = null; // first non-picker-iframe element
      
      // get elements at point
      let elementsAtPoint = document.elementsFromPoint(elementPicker._lastClientX, elementPicker._lastClientY);
      for (let el of elementsAtPoint) {
        if (el != elementPicker.iframe) {
          innermostTargetAtPoint = el;
          break;
        }
      }
      // remove iframe from array (if present)
      const pickerIFrameIdx = elementsAtPoint.indexOf(elementPicker.iframe);
      if (pickerIFrameIdx >= 0) elementsAtPoint.splice(pickerIFrameIdx, 1);
      
      // restore saved pointer-events prop of fixedVideosMap
      for (let [video, style] of fixedVideosMap.entries()) {
        video.style.setProperty(style.prop, style.value, style.priority);
      }
      fixedVideosMap.clear();

      // build ancestors array
      let ancestorsAndSelf = [];
      for (let el=innermostTargetAtPoint; el != null; el = el.parentElement) {
        ancestorsAndSelf.push(el);
      }
      
      debug.log('[POPElement:CTX] ancestors:', ancestorsAndSelf);
      debug.log('[POPElement:CTX] elementsAtPoint:', [elementPicker._lastClientX, elementPicker._lastClientY], elementsAtPoint);
      
      let elementsToMerge = elementsAtPoint;
      
      // merge ancestors with elementsToMerge
      let mergeAtIndices = [];
      let ancestorsSet = new Set(ancestorsAndSelf);
      for (let el of elementsToMerge) {
        if (ancestorsSet.has(el)) {
          continue;
        }
        for (let [idx, ancestor] of Object.entries(ancestorsAndSelf)) {
          if (ancestor.contains(el)) {
            mergeAtIndices.push({ element:el, index:idx });
            ancestorsSet.add(el);
            break;
          }
        }
      }
      debug.log('[POPElement:CTX] mergeAtIndices:', mergeAtIndices);
      for (let mergeInfo of mergeAtIndices.toReversed()) {
        const {element, index} = mergeInfo;
        if (index == -1) {
          ancestorsAndSelf.push(element);
        } else {
          ancestorsAndSelf.splice(index, 0, element);
        }
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
      debug.log(`[POPElement:CTX] ${newTargetIdx}/${ancestorsAndSelfLength - 1}`, 'prev:', targetHasPrev, 'next:', targetHasNext, 'newTarget:', newTarget, 'ancestorsAndSelf:', ancestorsAndSelf);
      if (newTarget && newTarget != target) {
        elementPicker.highlight(newTarget);
      }
    }
  }, true);

})();
