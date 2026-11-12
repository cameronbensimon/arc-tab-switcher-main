// Content script for Arc Tab Switcher

let switcherVisible = false;
let currentTabs = [];
let currentTabId = null;
let selectedIndex = 0;
let searchQuery = "";
let autoSwitchTimer = null;

// Timestamp of the last backward step triggered by the overlay's Shift+Q keydown handler.
// Used to avoid double-stepping if both the keydown and the background command fire.
let lastKeyboardBackStepTime = -Infinity;
const KEYBOARD_STEP_DEDUPE_MS = 150;

// Modifier keys (KeyboardEvent.key names) whose release commits the selected tab.
// Provided by background.js from the user's configured shortcut (e.g. Option+S -> "Alt").
const DEFAULT_RELEASE_KEYS = ['Control', 'Meta', 'Alt'];
let releaseKeys = new Set(DEFAULT_RELEASE_KEYS);

// KeyboardEvent.code of the switcher shortcut's key (e.g. "KeyS" for Option+S).
// Shift + this key moves to the previous tab while the switcher is open.
let cycleKeyCode = 'KeyQ';

// Track modifier key state at all times so we can tell if the user already released
// the modifier before the switcher message arrived from the background script
// (e.g. a quick Option+S tap to jump to the previous tab).
const MODIFIER_KEYS = ['Control', 'Meta', 'Alt'];
const modifierState = {}; // key -> { down: boolean, lastUp: number }
const RECENT_RELEASE_MS = 1000;

window.addEventListener('keydown', (e) => {
  if (MODIFIER_KEYS.includes(e.key)) {
    modifierState[e.key] = { ...modifierState[e.key], down: true };
  }
}, true);

window.addEventListener('keyup', (e) => {
  if (MODIFIER_KEYS.includes(e.key)) {
    modifierState[e.key] = { down: false, lastUp: performance.now() };
  }
}, true);

window.addEventListener('blur', () => {
  // Keyups are missed while the page isn't focused; don't trust stale "down" state
  for (const key of Object.keys(modifierState)) {
    modifierState[key].down = false;
  }
});

// True if the page saw the shortcut's modifier go down and come back up just now,
// i.e. the user has already let go and we should switch without waiting for a keyup
function shortcutModifierAlreadyReleased() {
  const now = performance.now();
  let sawRecentRelease = false;
  for (const key of releaseKeys) {
    const state = modifierState[key];
    if (!state) continue;
    if (state.down) return false;
    if (state.lastUp !== undefined && now - state.lastUp < RECENT_RELEASE_MS) {
      sawRecentRelease = true;
    }
  }
  return sawRecentRelease;
}

// Default icon (globe) for pages without a favicon. Percent-encoded so the data URL
// contains no raw quotes and is safe to use anywhere a URL is expected.
const DEFAULT_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="24px" width="24px" fill="#666666"><path d="M12,22q-2.07,0-3.9-0.79q-1.82-0.79-3.17-2.14Q3.58,17.73 2.79,15.9T2,12Q2,9.92 2.79,8.1Q3.58,6.27 4.93,4.93Q6.28,3.57 8.1,2.79Q9.93,2 12,2t3.9,0.79t3.17,2.14q1.35,1.35 2.14,3.17Q22,9.92 22,12t-0.79,3.9t-2.14,3.17q-1.35,1.35-3.17,2.14T12,22Zm0-2q3.35,0 5.68-2.32T20,12q0-0.18-0.01-0.36t-0.01-0.31q-0.13,0.72-0.68,1.2T18,13H16q-0.82,0-1.41-0.59T14,11V10H10V8q0-0.82 0.59-1.41T12,6h1q0-0.57 0.31-1.01t0.76-0.71q-0.5-0.13-1.01-0.2T12,4Q8.65,4 6.33,6.32T4,12H9q1.65,0 2.83,1.17T13,16v1H10v2.75q0.5,0.13 0.99,0.19T12,20Z"/></svg>'
);

// Calculate how many tabs can fit in the current window width
function getMaxTabsForWidth() {
  const windowWidth = window.innerWidth;
  const tabWidth = 160; // Card width
  const tabGap = 8; // Gap between cards
  const containerPadding = 24; // 12px on each side
  const minMargin = 40; // Minimum margin from window edges
  
  // Available width for tabs
  const availableWidth = windowWidth - minMargin * 2 - containerPadding;
  
  // Calculate how many tabs fit: width = (tabWidth * n) + (tabGap * (n-1))
  // Solving: availableWidth = tabWidth * n + tabGap * n - tabGap
  // availableWidth = n * (tabWidth + tabGap) - tabGap
  const maxTabs = Math.floor((availableWidth + tabGap) / (tabWidth + tabGap));
  
  // Clamp between 1 and 5 (Arc/Zen browser default max)
  return Math.max(1, Math.min(5, maxTabs));
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    if (request.action === "ping") {
      sendResponse({ success: true });
    } else if (request.action === "toggleSwitcher") {
      currentTabs = request.tabs || [];
      currentTabId = request.currentTabId;
      
      // Limit tabs based on available window width
      const maxTabs = getMaxTabsForWidth();
      const limitedTabs = currentTabs.slice(0, maxTabs);
      currentTabs = limitedTabs;

      const backward = request.direction === "backward";
      const requestReleaseKeys = request.releaseKeys && request.releaseKeys.length
        ? request.releaseKeys
        : DEFAULT_RELEASE_KEYS;
      cycleKeyCode = request.cycleKeyCode || 'KeyQ';

      if (switcherVisible) {
        // Forward and backward shortcuts may use different modifiers; watch both
        requestReleaseKeys.forEach(key => releaseKeys.add(key));
        // Already visible, cycle to next/previous tab. Skip if the overlay's own
        // Shift+Q keydown handler just moved the selection for this same keypress.
        if (!(backward && performance.now() - lastKeyboardBackStepTime < KEYBOARD_STEP_DEDUPE_MS)) {
          moveSelection(backward ? -1 : 1);
        }
      } else {
        releaseKeys = new Set(requestReleaseKeys);

        // Going forward starts with the second tab selected (mimics ctrlTab behavior
        // where the first tab shown is the previous tab); going backward starts at
        // the end of the list.
        if (backward) {
          selectedIndex = Math.max(0, currentTabs.length - 1);
        } else {
          selectedIndex = currentTabs.length > 1 ? 1 : 0;
        }

        // If the modifier was already released before this message arrived,
        // switch right away instead of showing the overlay
        if (shortcutModifierAlreadyReleased() && currentTabs[selectedIndex]) {
          switchToTab(currentTabs[selectedIndex].id);
          sendResponse({ success: true });
          return true;
        }

        // Show UI immediately
        showSwitcher();
        // Start timer to auto-switch if user stops pressing the key (simulates key release)
        startAutoSwitchTimer();
      }
      sendResponse({ success: true });
    } else if (request.action === "copyURL") {
      // Copy URL to clipboard and show toast
      copyURLToClipboard(request.url);
      sendResponse({ success: true });
    }
  } catch (error) {
    console.error("Error in message listener:", error);
    sendResponse({ success: false, error: error.message });
  }
  return true;
});

// Create and show the switcher overlay
function showSwitcher() {
  if (switcherVisible) return;
  
  switcherVisible = true;
  searchQuery = "";
  
  // Notify background that switcher is now visible
  chrome.runtime.sendMessage({ action: "switcherShown" });
  
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = 'arc-tab-switcher-overlay';
  overlay.innerHTML = `
    <div class="arc-switcher-container">
      <div class="arc-tabs-grid" id="arc-tabs-grid"></div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // Render tabs
  renderTabs();
  
  // Setup event listeners
  setupEventListeners();
}

// Hide the switcher
function hideSwitcher() {
  if (!switcherVisible) return;
  
  const overlay = document.getElementById('arc-tab-switcher-overlay');
  if (overlay) {
    overlay.remove();
  }
  
  // Clean up global event listeners
  document.removeEventListener('keydown', handleGlobalKeydown, true);
  document.removeEventListener('keyup', handleGlobalKeyup, true);
  
  // Clear auto-switch timer
  if (autoSwitchTimer) {
    clearTimeout(autoSwitchTimer);
    autoSwitchTimer = null;
  }
  
  switcherVisible = false;
  searchQuery = "";
  
  // Notify background that switcher is now hidden
  chrome.runtime.sendMessage({ action: "switcherHidden" });
}

// Start or restart the auto-switch timer
function startAutoSwitchTimer() {
  // Clear existing timer
  if (autoSwitchTimer) {
    clearTimeout(autoSwitchTimer);
  }
  
  // Set new timer - auto switch after 2000ms of inactivity (fallback in case keyup isn't detected)
  // The primary exit mechanism is the Control/Meta keyup event
  autoSwitchTimer = setTimeout(() => {
    const filteredTabs = getFilteredTabs();
    if (filteredTabs[selectedIndex]) {
      switchToTab(filteredTabs[selectedIndex].id);
    }
  }, 200000);
}

// Move the selection by `delta` (1 = next, -1 = previous), wrapping around
function moveSelection(delta) {
  const filteredTabs = getFilteredTabs();
  if (filteredTabs.length === 0) return;

  const count = filteredTabs.length;
  selectedIndex = ((selectedIndex + delta) % count + count) % count;
  renderTabs();
  // Reset auto-switch timer
  startAutoSwitchTimer();
}

// Render tabs in the grid
function renderTabs() {
  const grid = document.getElementById('arc-tabs-grid');
  if (!grid) return;
  
  const filteredTabs = getFilteredTabs();
  
  // Adjust selected index if needed
  if (selectedIndex >= filteredTabs.length) {
    selectedIndex = filteredTabs.length - 1;
  }
  if (selectedIndex < 0) {
    selectedIndex = 0;
  }
  
  grid.innerHTML = '';
  
  if (filteredTabs.length === 0) {
    grid.innerHTML = '<div class="arc-no-results">No tabs found</div>';
    return;
  }
  
  filteredTabs.forEach((tab, index) => {
    const tabCard = document.createElement('div');
    tabCard.className = 'arc-tab-card';
    if (index === selectedIndex) {
      tabCard.classList.add('selected');
    }
    if (tab.id === currentTabId) {
      tabCard.classList.add('current');
    }
    
    // Truncate title
    const title = tab.title || 'Untitled';
    const displayTitle = title.length > 30 ? title.substring(0, 27) + '...' : title;
    
    // Get favicon URL or use default
    const faviconUrl = tab.favIconUrl || DEFAULT_FAVICON;

    tabCard.innerHTML = `
      <div class="arc-tab-preview"></div>
      <div class="arc-tab-info">
        <div class="arc-tab-title">
          <img class="arc-tab-favicon" alt="">
          <span>${escapeHtml(displayTitle)}</span>
        </div>
      </div>
    `;

    // Set image sources via DOM properties (not HTML string interpolation) so
    // quotes or other special characters in the URLs can't break the markup
    setFaviconSrc(tabCard.querySelector('.arc-tab-favicon'), faviconUrl);

    // Preview: the real screenshot if we have one, otherwise the favicon centered
    // at its natural size (scaled down only if it's larger than the preview area)
    const previewImg = document.createElement('img');
    previewImg.alt = '';
    if (tab.screenshot) {
      previewImg.src = tab.screenshot;
    } else {
      previewImg.className = 'arc-tab-preview-favicon';
      setFaviconSrc(previewImg, faviconUrl);
    }
    tabCard.querySelector('.arc-tab-preview').appendChild(previewImg);

    tabCard.dataset.tabIndex = index;
    
    grid.appendChild(tabCard);
  });
  
  // Scroll selected card into view (instant, no animation)
  const selectedCard = grid.querySelector('.arc-tab-card.selected');
  if (selectedCard) {
    selectedCard.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
}

// Get filtered tabs based on search query
function getFilteredTabs() {
  if (!searchQuery) {
    return currentTabs;
  }
  
  const query = searchQuery.toLowerCase();
  return currentTabs.filter(tab => {
    const title = (tab.title || '').toLowerCase();
    const url = (tab.url || '').toLowerCase();
    return title.includes(query) || url.includes(query);
  });
}

// Setup event listeners
function setupEventListeners() {
  // Global keyboard listeners. Registered in the capture phase so they still run
  // even though the shortcut-blocking capture listener below stops propagation.
  document.addEventListener('keydown', handleGlobalKeydown, true);
  document.addEventListener('keyup', handleGlobalKeyup, true);
}

// Handle global keydown when switcher is open
function handleGlobalKeydown(e) {
  if (!switcherVisible) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    hideSwitcher();
  } else if (e.shiftKey && e.code === cycleKeyCode) {
    // Shift + the switcher shortcut's key (Q by default) moves to the previous tab.
    // Matched by e.code because modifiers like Option change e.key (Option+Shift+Q = "Œ").
    // (Forward cycling is handled by background.js commands.)
    e.preventDefault();
    lastKeyboardBackStepTime = performance.now();
    moveSelection(-1);
  }
}

// Handle global keyup when switcher is open
function handleGlobalKeyup(e) {
  if (!switcherVisible) return;
  
  // When the shortcut's modifier (Ctrl, Cmd, Option/Alt, ...) is released,
  // immediately switch to the selected tab
  if (releaseKeys.has(e.key)) {
    e.preventDefault();
    const filteredTabs = getFilteredTabs();
    if (filteredTabs[selectedIndex]) {
      // Cancel the timer and switch immediately
      if (autoSwitchTimer) {
        clearTimeout(autoSwitchTimer);
        autoSwitchTimer = null;
      }
      switchToTab(filteredTabs[selectedIndex].id);
    }
  }
}

// Switch to a tab
function switchToTab(tabId) {
  chrome.runtime.sendMessage({
    action: "switchToTab",
    tabId: tabId
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error switching tab:", chrome.runtime.lastError);
    }
    hideSwitcher();
  });
}

// Set a favicon <img> source, falling back to the default icon if it fails to load
function setFaviconSrc(img, url) {
  img.addEventListener('error', () => {
    if (img.src !== DEFAULT_FAVICON) {
      img.src = DEFAULT_FAVICON;
    }
  });
  img.src = url;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Copy URL to clipboard and show toast notification
function copyURLToClipboard(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('URL copied to clipboard');
  }).catch(err => {
    console.error('Failed to copy URL:', err);
    showToast('Failed to copy URL');
  });
}

// Show toast notification in top right corner
function showToast(message) {
  // Remove existing toast if any
  const existingToast = document.getElementById('arc-url-copy-toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  // Create toast element
  const toast = document.createElement('div');
  toast.id = 'arc-url-copy-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: rgba(30, 30, 35, 0.95);
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 2147483647;
    transition: opacity 0.3s ease;
    pointer-events: none;
  `;
  
  document.body.appendChild(toast);
  
  // Auto-remove after 2 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 2000);
}

// Prevent keyboard shortcuts from triggering browser actions
document.addEventListener('keydown', (e) => {
  // Prevent Ctrl+Q / Ctrl+Shift+Q from triggering browser quit
  if ((e.metaKey || e.ctrlKey) && (e.key || '').toLowerCase() === 'q') {
    e.preventDefault();
    e.stopPropagation();
  }
  // Prevent Shift+Ctrl/Cmd+C default behavior
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);