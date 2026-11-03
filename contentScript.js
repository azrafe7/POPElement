"use strict";

(() => {
  
  const DEBUG = false;
  let debug = {
    log: DEBUG ? console.log.bind(console) : () => {} // log or NO_OP
  }

  let manifest = chrome.runtime.getManifest();
  console.log(manifest.name + " v" + manifest.version);

  // event names exchanged with background.js (keep in sync)
  const EVENTS = {
    POP_OUT_ELEMENT: 'popOutElement',
    POP_OUT_PAGE: 'popOutPage',
    POP_IN_PAGE: 'popInPage',
    TOGGLE_PICKER: 'togglePicker',
    SCROLL_INTO_VIEW: 'scrollIntoView',
    CHECK_STATE: 'checkState',
  };

  // picker colors (other options: red rgba(250, 70, 60, ...), green rgba(17, 193, 12, ...), orange rgba(255, 175, 12, ...))
  const HIGHLIGHT_BG_COLOR = "rgba(20, 80, 250, 0.5)";
  const OUTLINE_COLOR = "rgba(20, 140, 200, 0.9)";

  const PICKER_CURSOR = "crosshair";

  // keys handled by the picker while it is active (the page must not see them)
  const PICKER_KEYS = ['Escape', 'Space', 'KeyA', 'KeyQ'];

  let lastTriggeredElement = null;

  const scrollIntoViewOptions = { behavior:"smooth", block:"center", inline:"center" };

  let oldStylesByElement = new Map(); // ['element':[{'style':'name', 'value':'value', 'priority':'value'}]];

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

  // all siblings of all the given elements (without the elements themselves)
  function getSiblingsOf(elements) {
    let allSiblings = [];
    for (const el of elements) {
      if (el.parentElement) {
        let children = Array.from(el.parentElement.children);
        let siblings = children.filter((child) => child != el);
        allSiblings = allSiblings.concat(siblings);
      } else {
        // detached/root element: walk the sibling chain
        let prevSibling = el.previousElementSibling;
        while (prevSibling) {
          allSiblings.push(prevSibling);
          prevSibling = prevSibling.previousElementSibling;
        }
        let nextSibling = el.nextElementSibling;
        while (nextSibling) {
          allSiblings.push(nextSibling);
          nextSibling = nextSibling.nextElementSibling;
        }
      }
    }
    
    return allSiblings;
  }

  // undo everything done by popWindow(): restore styles and remove classes
  function restorePage() {
    resetOldStyles(); // reset styles before removing classes
    
    const classes = ['--popped-element', '--non-popped-element', '--popped-element-ancestor', '--popped-element-parent'];
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

  function popWindow(target) {
    debug.log("[POPElement:CTX] target:", target);
    if (elementPicker) debug.log("[POPElement:CTX] info:", elementPicker.hoverInfo);
    lastTriggeredElement = target;
    
    // popOutPage if target is the root element
    if (target.parentElement == null) {
      chrome.runtime.sendMessage({event: EVENTS.POP_OUT_PAGE, data: null});
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
    if (DEBUG) {
      let ancestorsPosition = ancestors.map((el) => ({ el:el, position:getComputedStyle(el)['position'] }));
      debug.log('[POPElement:CTX] ancestorsPosition:', ancestorsPosition);
    }
    
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
    
    debug.log("[POPElement:CTX] oldStylesByElement:", oldStylesByElement);
    
    let data = { elementSize:elementSize, screenAvailSize:screenAvailSize };
    debug.log('[POPElement:CTX] popOutElement:', data);
    chrome.runtime.sendMessage({ event:EVENTS.POP_OUT_ELEMENT, data });
  }

  function createPicker() {
    debug.log("[POPElement:CTX] createPicker()");

    elementPicker = new ElementPicker(options);

    elementPicker.action = {
      trigger: "mouseup",
      
      callback: ((event, target) => {
        debug.log("[POPElement:CTX] event:", event);
        event.triggered = event.triggered ?? event.button == 0; // only proceed if left mouse button was pressed or "event.triggered" was set
        if (event.triggered) {
          popWindow(target);
        }
        
        closePicker();
      })
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    debug.log("[POPElement:CTX] onMessage:", msg);
    const { event, data } = msg;

    if (event === EVENTS.TOGGLE_PICKER) {
      let enabled = elementPicker?.enabled ?? false;
      let toggledEnable = !enabled;
      if (toggledEnable) {
        createPicker();
        elementPicker.enabled = true;
        elementPicker.hoverBox.style.cursor = PICKER_CURSOR;
      } else {
        closePicker();
      }
    } else if (event === EVENTS.POP_OUT_PAGE) {
      if (elementPicker?.enabled) closePicker();
      chrome.runtime.sendMessage({event: EVENTS.POP_OUT_PAGE, data: null});
    } else if (event === EVENTS.POP_IN_PAGE) {
      restorePage();
    } else if (event === EVENTS.SCROLL_INTO_VIEW) {
      if (lastTriggeredElement) {
        lastTriggeredElement.scrollIntoView(scrollIntoViewOptions);
      }
      lastTriggeredElement = null;
    } else if (event === EVENTS.CHECK_STATE) {
      sendResponse({event: 'setState', data: { allowed:true }});
    }
  });

  // elements under the picker's last mouse position (innermost first), without the picker's own iframe
  function getPickableElementsAtPoint() {
    // temporarily set pointer-events:all for all videos
    // (as pointer-events:none will prevent elements to be returned by elementsFromPoint())
    const POINTER_EVENTS = 'pointer-events';
    const fixedVideosMap = new Map(); // [element: { value, priority }]
    for (const video of document.querySelectorAll('video')) {
      if (getComputedStyle(video)[POINTER_EVENTS] === 'none') {
        fixedVideosMap.set(video, {
          value: video.style.getPropertyValue(POINTER_EVENTS),
          priority: video.style.getPropertyPriority(POINTER_EVENTS),
        });
        video.style.setProperty(POINTER_EVENTS, 'all', 'important');
      }
    }
    debug.log(`[POPElement:CTX] fixedVideosMap (${fixedVideosMap.size}):`, fixedVideosMap);

    const elementsAtPoint = document
      .elementsFromPoint(elementPicker._lastClientX, elementPicker._lastClientY)
      .filter((el) => el != elementPicker.iframe);

    // restore saved pointer-events prop of fixedVideosMap
    for (const [video, style] of fixedVideosMap.entries()) {
      video.style.setProperty(POINTER_EVENTS, style.value, style.priority);
    }
    return elementsAtPoint;
  }

  // move the picker's highlight to the parent (step = +1, key Q) or child (step = -1, key A) of the current target
  function drillPicker(step) {
    const target = elementPicker.hoverInfo.element;
    const elementsAtPoint = getPickableElementsAtPoint();

    // build ancestors array, starting at the innermost element at point
    const ancestorsAndSelf = [];
    for (let el = elementsAtPoint[0] ?? null; el != null; el = el.parentElement) {
      ancestorsAndSelf.push(el);
    }

    debug.log('[POPElement:CTX] ancestors:', ancestorsAndSelf);
    debug.log('[POPElement:CTX] elementsAtPoint:', [elementPicker._lastClientX, elementPicker._lastClientY], elementsAtPoint);

    // merge the elements at point (e.g. overlays) into the ancestors array, just before the first ancestor containing them
    const mergeAtIndices = [];
    const ancestorsSet = new Set(ancestorsAndSelf);
    for (const el of elementsAtPoint) {
      if (ancestorsSet.has(el)) continue;
      const index = ancestorsAndSelf.findIndex((ancestor) => ancestor.contains(el));
      if (index >= 0) {
        mergeAtIndices.push({ element:el, index:index });
        ancestorsSet.add(el);
      }
    }
    debug.log('[POPElement:CTX] mergeAtIndices:', mergeAtIndices);
    for (const { element, index } of mergeAtIndices.toReversed()) {
      ancestorsAndSelf.splice(index, 0, element);
    }

    const targetIdx = ancestorsAndSelf.indexOf(target);
    const newTarget = ancestorsAndSelf[targetIdx + step];
    debug.log(`[POPElement:CTX] ${targetIdx + step}/${ancestorsAndSelf.length - 1}`, 'newTarget:', newTarget, 'ancestorsAndSelf:', ancestorsAndSelf);
    if (newTarget && newTarget != target) {
      elementPicker.highlight(newTarget);
    }
  }

  // close picker when pressing ESC
  window.addEventListener('keyup', function(e) {
    if (elementPicker?.enabled && PICKER_KEYS.includes(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (e.code === 'Escape' && elementPicker?.enabled) {
      closePicker();
      debug.log("[POPElement:CTX] user aborted");
    }
  }, true);

  window.addEventListener('keydown', function(e) {
    if (!elementPicker?.enabled || !PICKER_KEYS.includes(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    if (e.code === 'Space') {
      debug.log("[POPElement:CTX] space-clicked target:", elementPicker.hoverInfo.element);
      e.triggered = true; // checked inside action callback
      elementPicker.trigger(e);
    } else if (e.code === 'KeyQ') { // drill up
      drillPicker(+1);
    } else if (e.code === 'KeyA') { // drill down
      drillPicker(-1);
    }
  }, true);

})();
