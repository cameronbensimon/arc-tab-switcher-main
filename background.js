// Background service worker for Arc Tab Switcher

// Track MRU (Most Recently Used) tab order
let mruTabOrder = [];

// Cache for tab screenshots
let tabScreenshotCache = new Map();

// Track if the switcher is currently visible (to avoid capturing it in screenshots)
let switcherVisible = false;

// Track pending screenshot captures to prevent race conditions
let pendingScreenshotCapture = null;
let lastCapturedTabId = null;

// Listen for tab activation to maintain MRU order and capture screenshot
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tabId = activeInfo.tabId;
  // Remove tab if it exists in the list
  mruTabOrder = mruTabOrder.filter(id => id !== tabId);
  // Add to front of list (most recent)
  mruTabOrder.unshift(tabId);
  // Keep a reasonable limit
  if (mruTabOrder.length > 100) {
    mruTabOrder = mruTabOrder.slice(0, 100);
  }
  
  // Cancel any pending screenshot capture
  if (pendingScreenshotCapture) {
    clearTimeout(pendingScreenshotCapture);
    pendingScreenshotCapture = null;
  }
  
  // Capture screenshot of newly active tab after a delay
  // Don't capture if switcher is visible (would include switcher overlay in screenshot)
  pendingScreenshotCapture = setTimeout(async () => {
    if (switcherVisible) {
      return; // Skip capture while switcher is visible
    }
    
    // Double-check this is still the active tab
    try {
      const [currentActiveTab] = await chrome.tabs.query({ active: true, windowId: activeInfo.windowId });
      if (!currentActiveTab || currentActiveTab.id !== tabId) {
        // Tab is no longer active, don't capture
        return;
      }
      
      const tab = await chrome.tabs.get(tabId);
      if (tab && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
        // Don't recapture the same tab immediately
        if (lastCapturedTabId === tabId) {
          return;
        }
        
        // Use regular captureVisibleTab for active tabs (faster, no debugger warning)
        const dataUrl = await chrome.tabs.captureVisibleTab(activeInfo.windowId, { 
          format: 'jpeg', 
          quality: 50 
        });
        tabScreenshotCache.set(tabId, dataUrl);
        lastCapturedTabId = tabId;
        
        // Limit cache size to 20 most recent tabs
        if (tabScreenshotCache.size > 20) {
          const oldestKey = tabScreenshotCache.keys().next().value;
          tabScreenshotCache.delete(oldestKey);
        }
      }
    } catch (error) {
      // Ignore errors for restricted pages
    }
    
    pendingScreenshotCapture = null;
  }, 800); // Increased delay to 800ms to let page settle
});

// Listen for tab removal to clean up MRU list and cache
chrome.tabs.onRemoved.addListener((tabId) => {
  mruTabOrder = mruTabOrder.filter(id => id !== tabId);
  tabScreenshotCache.delete(tabId);
  
  // Clear last captured tab if it was this one
  if (lastCapturedTabId === tabId) {
    lastCapturedTabId = null;
  }
});

// Listen for tab updates (URL changes, page load completion)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Capture screenshot when page finishes loading and tab is active
  // Don't capture if switcher is visible (would include switcher overlay in screenshot)
  if (changeInfo.status === 'complete' && tab.active && tab.windowId !== undefined && !switcherVisible) {
    // Wait a bit for page to fully render
    setTimeout(async () => {
      try {
        // Double-check tab is still active
        const [currentActiveTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        if (!currentActiveTab || currentActiveTab.id !== tabId) {
          return;
        }
        
        if (!tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { 
            format: 'jpeg', 
            quality: 50 
          });
          tabScreenshotCache.set(tabId, dataUrl);
          lastCapturedTabId = tabId;
        }
      } catch (error) {
        // Ignore errors for restricted pages
      }
    }, 500);
  }
});

// Handle window focus changes
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // No window focused
    return;
  }
  // Update MRU order when switching windows
  chrome.tabs.query({ active: true, windowId: windowId }).then(tabs => {
    if (tabs.length > 0) {
      const tabId = tabs[0].id;
      mruTabOrder = mruTabOrder.filter(id => id !== tabId);
      mruTabOrder.unshift(tabId);
    }
  });
});

// Initialize MRU list when extension loads
chrome.tabs.query({}).then(tabs => {
  // Get current active tabs per window
  const activeTabIds = new Set();
  tabs.forEach(tab => {
    if (tab.active) {
      activeTabIds.add(tab.id);
    }
  });
  // Add active tabs first, then others
  mruTabOrder = [...activeTabIds, ...tabs.filter(t => !activeTabIds.has(t.id)).map(t => t.id)];
  
  // Capture screenshot of currently active tab in focused window
  const activeTab = tabs.find(t => t.active && t.windowId);
  if (activeTab && !activeTab.url.startsWith('chrome://') && !activeTab.url.startsWith('chrome-extension://') && !activeTab.url.startsWith('edge://') && !activeTab.url.startsWith('about:')) {
    setTimeout(async () => {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { 
          format: 'jpeg', 
          quality: 50 
        });
        tabScreenshotCache.set(activeTab.id, dataUrl);
      } catch (error) {
        // Ignore errors
      }
    }, 500);
  }
});

// Copy current tab URL to clipboard
async function copyCurrentTabURL() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.id) {
      console.warn("No active tab found");
      return;
    }

    // Check if tab URL is a restricted page
    if (tab.url && (tab.url.startsWith('chrome://') || 
                    tab.url.startsWith('chrome-extension://') ||
                    tab.url.startsWith('edge://') ||
                    tab.url.startsWith('about:'))) {
      console.warn("Cannot copy URL from restricted pages:", tab.url);
      return;
    }
    
    // Ensure content script is loaded
    const isLoaded = await ensureContentScript(tab.id);
    if (!isLoaded) {
      console.error("Could not load content script");
      return;
    }
    
    // Send message to content script to copy URL and show toast
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: "copyURL",
        url: tab.url
      });
    } catch (messageError) {
      console.error("Could not send message to tab:", messageError);
    }
  } catch (error) {
    console.error("Error copying URL:", error);
  }
}

// Listen for keyboard command
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-tab-switcher") {
    toggleTabSwitcher("forward");
  } else if (command === "cycle-tab-switcher-backward") {
    toggleTabSwitcher("backward");
  } else if (command === "copy-url") {
    await copyCurrentTabURL();
  }
});

// Fallback modifiers to watch for release if a shortcut can't be read/parsed
const DEFAULT_RELEASE_KEYS = ['Control', 'Meta', 'Alt'];

const isMacPromise = chrome.runtime.getPlatformInfo()
  .then(info => info.os === 'mac')
  .catch(() => false);

// Parse a shortcut string from chrome.commands.getAll() into:
// - releaseKeys: KeyboardEvent.key names of its modifiers (excluding Shift, which is
//   used for cycling backward), so the content script knows which keyup ends the switch
// - keyCode: KeyboardEvent.code of the non-modifier key (e.g. "KeyS"), or null
// Handles both "Alt+Shift+S" style and macOS glyph style ("⌥⇧S").
function parseShortcut(shortcut, isMac) {
  const releaseKeys = new Set();
  let rest = shortcut || '';

  // macOS glyphs
  const glyphs = { '⌘': 'Meta', '⌃': 'Control', '⌥': 'Alt', '⇧': null };
  for (const [glyph, key] of Object.entries(glyphs)) {
    if (rest.includes(glyph)) {
      if (key) releaseKeys.add(key);
      rest = rest.split(glyph).join('');
    }
  }

  // Word-style modifiers
  const tokens = rest.split('+').map(t => t.trim()).filter(Boolean);
  let mainKey = null;
  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case 'command':
      case 'cmd':
      case 'search':
        releaseKeys.add('Meta');
        break;
      case 'macctrl':
        releaseKeys.add('Control');
        break;
      case 'ctrl':
      case 'control':
        // In Chrome's shortcut syntax, "Ctrl" means Command on macOS
        releaseKeys.add('Control');
        if (isMac) releaseKeys.add('Meta');
        break;
      case 'alt':
      case 'option':
        releaseKeys.add('Alt');
        break;
      case 'shift':
        break;
      default:
        mainKey = token;
    }
  }

  let keyCode = null;
  if (mainKey && /^[a-z]$/i.test(mainKey)) {
    keyCode = 'Key' + mainKey.toUpperCase();
  } else if (mainKey && /^[0-9]$/.test(mainKey)) {
    keyCode = 'Digit' + mainKey;
  }

  return { releaseKeys: [...releaseKeys], keyCode };
}

// Get the modifiers to watch for release and the key that cycles the switcher,
// based on the user's currently configured shortcuts
async function getShortcutInfo(commandName) {
  try {
    const [commands, isMac] = await Promise.all([chrome.commands.getAll(), isMacPromise]);
    const byName = name => commands.find(c => c.name === name);

    const invoked = parseShortcut(byName(commandName)?.shortcut, isMac);
    const forward = parseShortcut(byName('toggle-tab-switcher')?.shortcut, isMac);

    return {
      releaseKeys: invoked.releaseKeys.length ? invoked.releaseKeys : DEFAULT_RELEASE_KEYS,
      cycleKeyCode: forward.keyCode || 'KeyQ'
    };
  } catch (error) {
    return { releaseKeys: DEFAULT_RELEASE_KEYS, cycleKeyCode: 'KeyQ' };
  }
}

// Sort tabs by MRU order
function sortTabsByMRU(tabs) {
  // Create a map of tab IDs to tab objects for quick lookup
  const tabMap = new Map(tabs.map(tab => [tab.id, tab]));
  
  // First, add tabs in MRU order that exist in the current window
  const sortedTabs = [];
  const addedIds = new Set();
  
  for (const tabId of mruTabOrder) {
    if (tabMap.has(tabId)) {
      sortedTabs.push(tabMap.get(tabId));
      addedIds.add(tabId);
    }
  }
  
  // Then add any remaining tabs (ones not yet in MRU tracking)
  for (const tab of tabs) {
    if (!addedIds.has(tab.id)) {
      sortedTabs.push(tab);
    }
  }
  
  return sortedTabs;
}

// Check if content script is loaded and inject if needed
async function ensureContentScript(tabId) {
  try {
    // Try to ping the content script
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return true;
  } catch (error) {
    // Content script not loaded, inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      
      await chrome.scripting.insertCSS({
        target: { tabId: tabId },
        files: ['styles.css']
      });
      
      // Give it a moment to initialize
      await new Promise(resolve => setTimeout(resolve, 50));
      return true;
    } catch (injectError) {
      console.error("Failed to inject content script:", injectError);
      return false;
    }
  }
}

// Max tabs the switcher overlay shows (content.js may show fewer on narrow windows)
const MAX_SWITCHER_TABS = 5;

// How long to wait for the content script to be ready before giving up on the
// overlay and switching tabs directly (e.g. page still loading)
const CONTENT_SCRIPT_TIMEOUT_MS = 300;

function isRestrictedUrl(url) {
  return !!url && (url.startsWith('chrome://') ||
                   url.startsWith('chrome-extension://') ||
                   url.startsWith('chrome-error://') ||
                   url.startsWith('edge://') ||
                   url.startsWith('about:') ||
                   url.startsWith('view-source:') ||
                   url.startsWith('devtools://'));
}

// Get the current window's tabs in MRU order, with the active tab first
async function getMRUTabs(activeTab) {
  const allTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  const others = sortTabsByMRU(allTabs).filter(t => t.id !== activeTab.id);
  return [activeTab, ...others];
}

// Fallback when the switcher overlay can't be shown on the current page:
// switch directly to the tab the overlay would have pre-selected
// (next MRU tab going forward, last tab in the switcher list going backward)
async function switchWithoutOverlay(activeTab, direction) {
  const tabs = (await getMRUTabs(activeTab)).slice(0, MAX_SWITCHER_TABS);
  if (tabs.length < 2) return;
  
  const target = direction === "backward" ? tabs[tabs.length - 1] : tabs[1];
  await chrome.tabs.update(target.id, { active: true });
}

// Resolve to `fallback` if the promise doesn't settle within `ms`
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

// Toggle the tab switcher
// direction: "forward" (next tab) or "backward" (previous tab)
async function toggleTabSwitcher(direction = "forward") {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.id) {
      console.warn("No active tab found");
      return;
    }

    // Restricted pages (chrome://, etc.) can't host the overlay
    if (isRestrictedUrl(tab.url)) {
      await switchWithoutOverlay(tab, direction);
      return;
    }
    
    // Ensure content script is loaded. If it can't be injected, or the page isn't
    // ready in time (still loading, no DOM), switch tabs directly instead.
    const isLoaded = await withTimeout(ensureContentScript(tab.id), CONTENT_SCRIPT_TIMEOUT_MS, false);
    if (!isLoaded) {
      await switchWithoutOverlay(tab, direction);
      return;
    }
    
    // Get MRU-ordered tabs, plus the configured shortcut's modifiers
    const [sortedTabs, shortcutInfo] = await Promise.all([
      getMRUTabs(tab),
      getShortcutInfo(direction === "backward" ? "cycle-tab-switcher-backward" : "toggle-tab-switcher")
    ]);
    
    // Attach cached screenshots to tabs (only the ones the switcher can show)
    const tabsWithScreenshots = sortedTabs.slice(0, MAX_SWITCHER_TABS).map(t => ({
      ...t,
      screenshot: tabScreenshotCache.get(t.id) || null
    }));
    
    // Send message to content script to show/hide switcher
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "toggleSwitcher",
      tabs: tabsWithScreenshots,
      currentTabId: tab.id,
      direction: direction,
      releaseKeys: shortcutInfo.releaseKeys,
      cycleKeyCode: shortcutInfo.cycleKeyCode
    });
    
    // Content script couldn't render the overlay (e.g. document has no body)
    if (!response || response.success === false) {
      await switchWithoutOverlay(tab, direction);
    }
  } catch (error) {
    console.error("Error toggling tab switcher, switching directly:", error);
    if (tab && tab.id) {
      try {
        await switchWithoutOverlay(tab, direction);
      } catch (switchError) {
        console.error("Error switching tab:", switchError);
      }
    }
  }
}

// Listen for tab switching requests from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "switchToTab") {
    chrome.tabs.update(request.tabId, { active: true })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Will respond asynchronously
  } else if (request.action === "closeTab") {
    chrome.tabs.remove(request.tabId)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Will respond asynchronously
  } else if (request.action === "getAllTabs") {
    chrome.tabs.query({ currentWindow: true })
      .then(tabs => sendResponse({ tabs: tabs }))
      .catch(error => sendResponse({ tabs: [], error: error.message }));
    return true; // Will respond asynchronously
  } else if (request.action === "switcherShown") {
    // Switcher is now visible - don't capture screenshots
    switcherVisible = true;
    sendResponse({ success: true });
  } else if (request.action === "switcherHidden") {
    // Switcher is now hidden - can capture screenshots again
    switcherVisible = false;
    
    // Capture screenshot of the newly active tab after switcher is hidden
    if (sender.tab && sender.tab.id) {
      setTimeout(async () => {
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          
          // Double-check this tab is still active
          const [currentActiveTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
          if (!currentActiveTab || currentActiveTab.id !== sender.tab.id) {
            return;
          }
          
          if (tab && tab.active && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { 
              format: 'jpeg', 
              quality: 50 
            });
            tabScreenshotCache.set(sender.tab.id, dataUrl);
            lastCapturedTabId = sender.tab.id;
          }
        } catch (error) {
          // Ignore errors
        }
      }, 500);
    }
    sendResponse({ success: true });
  }
});