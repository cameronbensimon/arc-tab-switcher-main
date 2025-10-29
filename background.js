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
    toggleTabSwitcher();
  } else if (command === "copy-url") {
    await copyCurrentTabURL();
  }
});

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

// Toggle the tab switcher
async function toggleTabSwitcher() {
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
      console.warn("Cannot run on restricted pages:", tab.url);
      return;
    }
    
    // Ensure content script is loaded
    const isLoaded = await ensureContentScript(tab.id);
    if (!isLoaded) {
      console.error("Could not load content script");
      return;
    }
    
    // Get all tabs in current window
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    
    // Sort tabs by MRU order
    const sortedTabs = sortTabsByMRU(allTabs);
    
    // Attach cached screenshots to tabs
    const tabsWithScreenshots = sortedTabs.map(t => ({
      ...t,
      screenshot: tabScreenshotCache.get(t.id) || null
    }));
    
    // Send message to content script to show/hide switcher
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: "toggleSwitcher",
        tabs: tabsWithScreenshots,
        currentTabId: tab.id
      });
    } catch (messageError) {
      console.error("Could not send message to tab:", messageError);
    }
  } catch (error) {
    console.error("Error toggling tab switcher:", error);
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