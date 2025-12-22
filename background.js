/**
 * JAL - Background Service Worker
 * Handles storage, command shortcuts, and cross-tab communication
 */

// Listen for keyboard commands
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'COMMAND', command })
        .catch(() => {
          // Content script not loaded on this page - that's OK
          console.log('JAL: Content script not available on this tab');
        });
    }
  });
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_COMMENTS':
      getComments(message.pageId).then(sendResponse);
      return true;

    case 'SAVE_COMMENT':
      saveComment(message.comment).then(sendResponse);
      return true;

    case 'UPDATE_COMMENT':
      updateComment(message.commentId, message.updates).then(sendResponse);
      return true;

    case 'DELETE_COMMENT':
      deleteComment(message.commentId).then(sendResponse);
      return true;

    case 'GET_JUMP_STACK':
      getJumpStack(message.pageId).then(sendResponse);
      return true;

    case 'PUSH_JUMP':
      pushJump(message.pageId, message.frame).then(sendResponse);
      return true;

    case 'POP_JUMP':
      popJump(message.pageId).then(sendResponse);
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// Storage helpers
async function getComments(pageId) {
  const result = await chrome.storage.local.get('comments');
  const allComments = result.comments || {};
  return allComments[pageId] || [];
}

async function saveComment(comment) {
  const result = await chrome.storage.local.get('comments');
  const allComments = result.comments || {};

  if (!allComments[comment.pageId]) {
    allComments[comment.pageId] = [];
  }

  allComments[comment.pageId].push(comment);
  await chrome.storage.local.set({ comments: allComments });

  return { success: true, comment };
}

async function updateComment(commentId, updates) {
  const result = await chrome.storage.local.get('comments');
  const allComments = result.comments || {};

  for (const pageId in allComments) {
    const idx = allComments[pageId].findIndex(c => c.commentId === commentId);
    if (idx !== -1) {
      allComments[pageId][idx] = { ...allComments[pageId][idx], ...updates };
      await chrome.storage.local.set({ comments: allComments });
      return { success: true };
    }
  }

  return { success: false, error: 'Comment not found' };
}

async function deleteComment(commentId) {
  const result = await chrome.storage.local.get('comments');
  const allComments = result.comments || {};

  for (const pageId in allComments) {
    const idx = allComments[pageId].findIndex(c => c.commentId === commentId);
    if (idx !== -1) {
      allComments[pageId].splice(idx, 1);
      await chrome.storage.local.set({ comments: allComments });
      return { success: true };
    }
  }

  return { success: false, error: 'Comment not found' };
}

async function getJumpStack(pageId) {
  const result = await chrome.storage.local.get('jumpStacks');
  const allStacks = result.jumpStacks || {};
  return allStacks[pageId] || [];
}

async function pushJump(pageId, frame) {
  const result = await chrome.storage.local.get('jumpStacks');
  const allStacks = result.jumpStacks || {};

  if (!allStacks[pageId]) {
    allStacks[pageId] = [];
  }

  allStacks[pageId].push(frame);
  await chrome.storage.local.set({ jumpStacks: allStacks });

  return { success: true };
}

async function popJump(pageId) {
  const result = await chrome.storage.local.get('jumpStacks');
  const allStacks = result.jumpStacks || {};

  if (!allStacks[pageId] || allStacks[pageId].length === 0) {
    return { success: false, frame: null };
  }

  const frame = allStacks[pageId].pop();
  await chrome.storage.local.set({ jumpStacks: allStacks });

  return { success: true, frame };
}

// Log extension loaded
console.log('JAL Background Service Worker loaded');
