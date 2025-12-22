/**
 * JAL - Popup Script
 * Handles popup UI interactions
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Check if we're on a supported page
  checkStatus();

  // Load statistics
  loadStats();

  // Fix shortcut labels for Mac
  updateShortcutLabels();

  // Setup action buttons
  document.getElementById('export-btn').addEventListener('click', exportComments);
  document.getElementById('import-btn').addEventListener('click', importComments);
  document.getElementById('clear-btn').addEventListener('click', clearAllComments);
});

function updateShortcutLabels() {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  if (isMac) {
    document.querySelectorAll('.shortcut-key').forEach(el => {
      el.textContent = el.textContent.replace('Alt+', '⌥');
    });
  }
}

async function checkStatus() {
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      statusEl.classList.add('inactive');
      statusText.textContent = 'No active tab';
      return;
    }

    const url = new URL(tab.url);
    const supportedHosts = [
      'chatgpt.com',
      'chat.openai.com',
      'claude.ai',
      'gemini.google.com',
      'deepseek.com'
    ];

    const isSupported = supportedHosts.some(host => url.hostname.includes(host));

    if (isSupported) {
      statusEl.classList.remove('inactive');
      statusText.textContent = `Active on ${url.hostname}`;
    } else {
      statusEl.classList.add('inactive');
      statusText.textContent = 'Not on a supported AI chat page';
    }
  } catch (error) {
    statusEl.classList.add('inactive');
    statusText.textContent = 'Error checking status';
  }
}

async function loadStats() {
  try {
    const result = await chrome.storage.local.get('comments');
    const allComments = result.comments || {};

    let totalComments = 0;
    let sentComments = 0;
    const pages = Object.keys(allComments).length;

    for (const pageId in allComments) {
      const pageComments = allComments[pageId];
      totalComments += pageComments.length;
      sentComments += pageComments.filter(c => c.status === 'sent' || c.status === 'queued').length;
    }

    document.getElementById('stat-comments').textContent = totalComments;
    document.getElementById('stat-sent').textContent = sentComments;
    document.getElementById('stat-pages').textContent = pages;
  } catch (error) {
    console.error('Error loading stats:', error);
  }
}

async function exportComments() {
  try {
    const result = await chrome.storage.local.get(['comments', 'jumpStacks']);

    const exportData = {
      version: '0.1.0',
      exportedAt: new Date().toISOString(),
      comments: result.comments || {},
      jumpStacks: result.jumpStacks || {}
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `jal-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
  } catch (error) {
    alert('Error exporting comments: ' + error.message);
  }
}

async function importComments() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';

  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.version || !data.comments) {
        throw new Error('Invalid export file format');
      }

      // Merge with existing data
      const existing = await chrome.storage.local.get(['comments', 'jumpStacks']);
      const mergedComments = { ...existing.comments, ...data.comments };
      const mergedStacks = { ...existing.jumpStacks, ...(data.jumpStacks || {}) };

      await chrome.storage.local.set({
        comments: mergedComments,
        jumpStacks: mergedStacks
      });

      alert('Comments imported successfully!');
      loadStats();
    } catch (error) {
      alert('Error importing comments: ' + error.message);
    }
  };

  input.click();
}

async function clearAllComments() {
  if (!confirm('Are you sure you want to delete all comments? This cannot be undone.')) {
    return;
  }

  try {
    await chrome.storage.local.set({
      comments: {},
      jumpStacks: {}
    });

    alert('All comments cleared!');
    loadStats();
  } catch (error) {
    alert('Error clearing comments: ' + error.message);
  }
}
