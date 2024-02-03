 # CHANGELOG

 ### v0.1.4 (31 Jan 2024)
 - avoid duplicates while merging (as elementsFromPoint() could return the same element more than once)
 - preventDefault and stopImmediatePropagation on keyUp/Dow
 
 ### v0.1.3 (27 Jan 2024)
 - make it work in incognito mode too
 
 ### v0.1.2 (26 Jan 2024)
 - also focus window when re-attaching as tab
 - only add "Remove CSS" contextMenu entry if DEBUG
  
 ### v0.1.1 (25 Jan 2024)
 - catch no last-focused window
 - apply/reset inline styles (instead of injecting CSS)
 - scrollIntoView
 - restrict popup win size, add overflow auto to ancestors if bigger than max size
 - popOutPage if target is the root element
 - merge ancestors with elementsAtPoint
 - removeCSS contextMenu entry
 - update meta and license

 ### v0.1.0 (19 Jan 2024)
 - initial version starting from a clone of PIPElement
 - add classes and inject CSS