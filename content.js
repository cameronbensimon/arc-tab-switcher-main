// Content script for Arc Tab Switcher

let switcherVisible = false;
let currentTabs = [];
let currentTabId = null;
let selectedIndex = 0;
let searchQuery = "";
let autoSwitchTimer = null;

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
      
      if (switcherVisible) {
        // Already visible, cycle to next tab
        const filteredTabs = getFilteredTabs();
        if (filteredTabs.length > 0) {
          selectedIndex = (selectedIndex + 1) % filteredTabs.length;
          renderTabs();
          // Reset auto-switch timer
          startAutoSwitchTimer();
        }
      } else {
        // Show UI immediately and start with second tab selected
        // This mimics ctrlTab behavior where first tab shown is the previous tab
        selectedIndex = currentTabs.length > 1 ? 1 : 0;
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
  document.removeEventListener('keydown', handleGlobalKeydown);
  document.removeEventListener('keyup', handleGlobalKeyup);
  
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
  }, 2000);
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
    
    // Use real screenshot if available, otherwise create mock preview
    let previewSrc;
    if (tab.screenshot) {
      previewSrc = tab.screenshot;
    } else {
      // Create a canvas-based preview that looks like a page
      const favicon = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="%23ddd"/></svg>';
      previewSrc = `data:image/svg+xml,${encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="200" height="125" viewBox="0 0 200 125">
          <rect width="200" height="125" fill="#ffffff"/>
          <rect x="15" y="15" width="50" height="6" fill="#333" opacity="0.6"/>
          <rect x="15" y="28" width="170" height="4" fill="#333" opacity="0.3"/>
          <rect x="15" y="36" width="160" height="4" fill="#333" opacity="0.3"/>
          <rect x="15" y="44" width="140" height="4" fill="#333" opacity="0.3"/>
          <rect x="15" y="60" width="90" height="8" fill="#e5e7eb" rx="2"/>
          <rect x="110" y="60" width="75" height="8" fill="#e5e7eb" rx="2"/>
          <image href="${favicon}" x="15" y="15" width="20" height="20"/>
        </svg>
      `)}`;
    }
    
    // Get favicon URL or use default
    const faviconUrl = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="%23888"/></svg>';
    
    tabCard.innerHTML = `
      <div class="arc-tab-preview">
        <img src="${previewSrc}" alt="">
      </div>
      <div class="arc-tab-info">
        <div class="arc-tab-title">
          <img class="arc-tab-favicon" src="${faviconUrl}" alt="">
          <span>${escapeHtml(displayTitle)}</span>
        </div>
      </div>
    `;
    
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
  // Global keyboard listeners
  document.addEventListener('keydown', handleGlobalKeydown);
  document.addEventListener('keyup', handleGlobalKeyup);
}

// Handle global keydown when switcher is open
function handleGlobalKeydown(e) {
  if (!switcherVisible) return;
  
  // Only handle Escape - Ctrl+Q cycling is handled by background.js
  if (e.key === 'Escape') {
    e.preventDefault();
    hideSwitcher();
  }
}

// Handle global keyup when switcher is open
function handleGlobalKeyup(e) {
  if (!switcherVisible) return;
  
  // When Control or Meta (Command) key is released, immediately switch to selected tab
  if (e.key === 'Control' || e.key === 'Meta') {
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
  // Prevent Ctrl+Q from triggering browser quit on Mac
  if ((e.metaKey || e.ctrlKey) && e.key === 'q') {
    e.preventDefault();
    e.stopPropagation();
  }
  // Prevent Shift+Ctrl/Cmd+C default behavior
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);