/**
 * JAL - Main Content Script
 * Handles overlay UI, selection, comments, and JAL/JR navigation
 */

(function() {
  'use strict';

  window.JAL = window.JAL || {};
  const JAL = window.JAL;

  // State
  JAL.state = {
    provider: null,
    adapter: null,
    pageId: null,
    comments: [],
    selectedComments: new Set(),
    commentsInComposer: new Set(), // Track comments currently added to chatbox
    jumpStack: [],
    isObserving: false,
    pendingJump: null, // Jump frame waiting for AI response
    ui: {
      container: null,
      commentPanel: null,
      floatingButton: null,
      highlights: new Map() // commentId -> highlight elements
    }
  };

  /**
   * Initialize JAL
   */
  JAL.init = async function() {
    console.log('JAL: Initializing...');

    // Detect provider
    JAL.state.provider = JAL.Utils.detectProvider();
    JAL.state.adapter = JAL.Providers[JAL.state.provider];

    if (!JAL.state.adapter || !JAL.state.adapter.isActive()) {
      console.log('JAL: No active provider found');
      return;
    }

    console.log(`JAL: Using ${JAL.state.provider} adapter`);

    // Get page ID
    JAL.state.pageId = JAL.Utils.getPageId(window.location.href);

    // Create UI
    JAL.UI.createOverlay();

    // Wait for messages to have actual content before marking
    await JAL.waitForMessageContent();

    // Mark existing messages (now they have content to fingerprint)
    JAL.markAllMessages();

    // Load existing comments (now messages have fingerprints to match against)
    await JAL.loadComments();

    // Setup event listeners
    JAL.setupEventListeners();

    // Start observing for new messages
    JAL.startObserving();

    // Start observing composer for send/clear events
    JAL.startComposerObserving();

    console.log('JAL: Initialized successfully');
  };

  /**
   * Start observing for when to mark comments as "asked"
   * Also detects when comments are removed from composer (back to draft)
   * Uses lightweight polling - only checks when comments are pending
   */
  JAL.startComposerObserving = function() {
    let lastAssistantCount = 0;
    let waitingForResponse = false;

    // Poll every 3 seconds (lightweight, doesn't affect streaming)
    setInterval(() => {
      // Check if any comments were removed from composer
      JAL.checkForRemovedComments();

      // Only proceed if we have comments in composer waiting to be marked
      if (JAL.state.commentsInComposer.size === 0) {
        waitingForResponse = false;
        return;
      }

      // Count current assistant messages
      const currentCount = JAL.state.adapter.getAssistantMessages().length;

      // If we haven't started waiting yet, record the current count
      if (!waitingForResponse) {
        lastAssistantCount = currentCount;
        waitingForResponse = true;
        console.log('JAL: Comments in composer, watching for new response...');
        return;
      }

      // Check if a new assistant message appeared AND streaming is done
      if (currentCount > lastAssistantCount && !JAL.isResponseStreaming()) {
        console.log('JAL: New response complete, marking comments as asked');
        JAL.markCommentsAsAsked();
        waitingForResponse = false;
        lastAssistantCount = currentCount;
      }
    }, 3000);
  };

  /**
   * Check if any comments were removed from the composer and mark them as draft
   * Only marks as draft if user manually deleted - NOT if message was sent
   */
  JAL.checkForRemovedComments = function() {
    if (JAL.state.commentsInComposer.size === 0) return;

    const composerContent = JAL.state.adapter.getComposerContent?.() || '';

    // If composer is completely empty, poll to check if response is generating
    if (composerContent.trim() === '') {
      // If already waiting, don't start another check
      if (JAL.state._waitingForEmptyCheck) return;

      JAL.state._waitingForEmptyCheck = true;
      console.log('JAL: Composer emptied, polling to detect if message was sent...');

      // Record the current assistant message count
      const initialCount = JAL.state.adapter.getAssistantMessages?.().length || 0;
      let pollCount = 0;
      const maxPolls = 10; // Poll up to 10 times (5 seconds total)

      const pollForResponse = () => {
        pollCount++;

        // Check if streaming is happening OR if a new message appeared
        const isStreaming = JAL.isResponseStreaming();
        const currentCount = JAL.state.adapter.getAssistantMessages?.().length || 0;
        const newMessageAppeared = currentCount > initialCount;

        if (isStreaming || newMessageAppeared) {
          // Message was sent! Turn green
          console.log('JAL: Message sent detected (streaming:', isStreaming, 'new message:', newMessageAppeared, '), marking as asked (green)');
          JAL.state._waitingForEmptyCheck = false;
          JAL.markCommentsAsAsked();
          return;
        }

        if (pollCount < maxPolls) {
          // Keep polling
          setTimeout(pollForResponse, 500);
        } else {
          // Timeout - no response detected, mark as draft
          JAL.state._waitingForEmptyCheck = false;
          console.log('JAL: No response detected after polling, marking comments as draft (orange)');
          for (const commentId of [...JAL.state.commentsInComposer]) {
            const comment = JAL.state.comments.find(c => c.commentId === commentId);
            if (comment) {
              JAL.state.commentsInComposer.delete(commentId);
              comment.status = 'draft';
              JAL.Storage.updateComment(commentId, { status: 'draft' });
              JAL.UI.updateCommentVisualState(commentId, 'draft');
            }
          }
        }
      };

      // Start polling after a short delay
      setTimeout(pollForResponse, 500);
      return;
    }

    // Check each comment in composer (when composer has content)
    for (const commentId of [...JAL.state.commentsInComposer]) {
      const comment = JAL.state.comments.find(c => c.commentId === commentId);
      if (!comment) continue;

      // Check if the comment's body text is still in composer
      const bodyText = comment.body;

      // Only mark as draft if comment body is not in composer
      if (!composerContent.includes(bodyText)) {
        console.log('JAL: Comment removed from composer, marking as draft:', commentId);
        JAL.state.commentsInComposer.delete(commentId);
        comment.status = 'draft';
        JAL.Storage.updateComment(commentId, { status: 'draft' });
        JAL.UI.updateCommentVisualState(commentId, 'draft');
      }
    }
  };

  /**
   * Mark all comments in composer as "asked" (green)
   */
  JAL.markCommentsAsAsked = function() {
    for (const commentId of JAL.state.commentsInComposer) {
      const comment = JAL.state.comments.find(c => c.commentId === commentId);
      if (comment) {
        comment.status = 'queued';
        JAL.Storage.updateComment(commentId, { status: 'queued' });
        JAL.UI.updateCommentVisualState(commentId, 'asked');
        console.log('JAL: Marked comment as asked:', commentId);
      }
    }
    JAL.state.commentsInComposer.clear();
  };

  /**
   * Check if ChatGPT is currently streaming a response
   */
  JAL.isResponseStreaming = function() {
    // ChatGPT shows a "Stop generating" button while streaming
    const stopButton = document.querySelector('button[aria-label="Stop generating"]');
    if (stopButton) return true;

    // Also check for the streaming indicator
    const streamingCursor = document.querySelector('.result-streaming');
    if (streamingCursor) return true;

    // Check for any button with "stop" in the aria-label or text
    const buttons = document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="stop"]');
    if (buttons.length > 0) return true;

    return false;
  };

  /**
   * Load comments from storage
   */
  JAL.loadComments = async function() {
    try {
      const comments = await JAL.Storage.getComments(JAL.state.pageId);
      JAL.state.comments = comments;
      JAL.UI.renderComments();
      JAL.UI.renderHighlights();

      // Retry with increasing delays if highlights are missing (content might still be loading)
      const retryRenderHighlights = (attempt, maxAttempts, delay) => {
        const renderedCount = JAL.state.ui.highlights.size;
        if (renderedCount < comments.length && attempt < maxAttempts) {
          console.log(`JAL: ${comments.length - renderedCount} highlights missing, retry ${attempt + 1}/${maxAttempts} in ${delay}ms...`);
          setTimeout(() => {
            JAL.markAllMessages();
            JAL.UI.renderHighlights();
            retryRenderHighlights(attempt + 1, maxAttempts, delay * 1.5);
          }, delay);
        }
      };
      retryRenderHighlights(0, 5, 500);
    } catch (err) {
      console.error('JAL: Error loading comments:', err);
    }
  };

  /**
   * Wait for message content to be available (ChatGPT loads progressively)
   */
  JAL.waitForMessageContent = async function() {
    const maxAttempts = 30;  // Increased for slow networks
    const delay = 100;

    for (let i = 0; i < maxAttempts; i++) {
      // Look for actual rendered markdown content
      const markdown = document.querySelector('[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] .prose');
      if (markdown && markdown.textContent && markdown.textContent.length > 10) {
        console.log('JAL: Message content ready after', i * delay, 'ms');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    console.log('JAL: Timeout waiting for message content');
  };

  /**
   * Mark all existing messages with fingerprints
   */
  JAL.markAllMessages = function() {
    const adapter = JAL.state.adapter;
    const messages = adapter.getAssistantMessages();

    messages.forEach(msg => {
      adapter.markMessage(msg);
    });
  };

  /**
   * Setup event listeners
   */
  JAL.setupEventListeners = function() {
    // Selection change - show floating button
    document.addEventListener('mouseup', JAL.handleSelection);
    document.addEventListener('keyup', JAL.handleSelection);

    // Keyboard commands
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'COMMAND') {
        JAL.handleCommand(message.command);
      }
    });

    // Handle navigation/URL changes - use History API instead of MutationObserver
    let lastUrl = window.location.href;
    const checkUrl = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        JAL.handleUrlChange();
      }
    };
    window.addEventListener('popstate', checkUrl);
    // Intercept pushState/replaceState for SPA navigation
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function() { origPush.apply(this, arguments); checkUrl(); };
    history.replaceState = function() { origReplace.apply(this, arguments); checkUrl(); };
  };

  /**
   * Handle URL changes (navigation within SPA)
   * This runs when user clicks + for new chat or navigates between conversations
   */
  JAL.handleUrlChange = async function() {
    console.log('JAL: URL changed, reinitializing...');

    // Clear existing highlights from old conversation
    document.querySelectorAll('.jal-highlight-overlay, .jal-underline, .jal-click-overlay').forEach(el => el.remove());
    JAL.state.ui.highlights.clear();

    // Clear old state
    JAL.state.comments = [];
    JAL.state.selectedComments.clear();
    JAL.state.commentsInComposer.clear();

    // Update page ID
    JAL.state.pageId = JAL.Utils.getPageId(window.location.href);
    console.log('JAL: New pageId:', JAL.state.pageId);

    // Wait for new messages to load (ChatGPT loads content dynamically)
    await JAL.waitForMessageContent();

    // Mark new messages
    JAL.markAllMessages();

    // Load comments for new page
    await JAL.loadComments();

    console.log('JAL: Reinitialized for new conversation');
  };

  /**
   * Handle text selection
   */
  JAL.handleSelection = function(e) {
    const selection = window.getSelection();

    if (!selection || selection.isCollapsed || selection.toString().trim().length === 0) {
      JAL.UI.hideFloatingButton();
      return;
    }

    const range = selection.getRangeAt(0);
    const container = JAL.state.adapter.findMessageContainer(range.commonAncestorContainer);

    if (!container || !JAL.state.adapter.isAssistantMessage(container)) {
      JAL.UI.hideFloatingButton();
      return;
    }

    const rect = range.getBoundingClientRect();
    JAL.UI.showFloatingButton(rect, container);
  };

  /**
   * Handle keyboard commands
   */
  JAL.handleCommand = function(command) {
    switch (command) {
      case 'jal-send':
        JAL.sendSelected();
        break;
      case 'jal-return':
        JAL.jumpReturn();
        break;
      case 'add-comment':
        JAL.addCommentFromSelection();
        break;
      case 'toggle-panel':
        JAL.UI.togglePanel();
        break;
    }
  };

  /**
   * Add a comment from current selection
   */
  JAL.addCommentFromSelection = async function() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      console.log('JAL: No selection');
      return;
    }

    const range = selection.getRangeAt(0);
    const container = JAL.state.adapter.findMessageContainer(range.commonAncestorContainer);

    if (!container) {
      console.log('JAL: Selection not in a message');
      return;
    }

    // Ensure message is marked
    JAL.state.adapter.markMessage(container);

    const messageText = JAL.state.adapter.getMessageText(container);
    const anchor = JAL.Anchoring.createAnchor(selection, container, messageText);

    if (!anchor) {
      console.log('JAL: Could not create anchor');
      return;
    }

    // Show comment input UI
    JAL.UI.showCommentInput(anchor, container);
  };

  /**
   * Save a new comment
   */
  JAL.saveComment = async function(anchor, body) {
    const comment = JAL.Storage.createComment(
      JAL.state.pageId,
      anchor,
      body,
      { status: 'draft' }
    );

    await JAL.Storage.saveComment(comment);
    JAL.state.comments.push(comment);

    JAL.UI.renderComments();
    JAL.UI.renderHighlights();

    // Clear selection
    window.getSelection().removeAllRanges();
  };

  /**
   * Start observing for new assistant messages
   * DISABLED - causes performance issues during streaming
   */
  JAL.startObserving = function() {
    // Intentionally empty - no observers needed
    // Comments are loaded on page load and URL change
    JAL.state.isObserving = true;
  };

  /**
   * Send selected comments (JAL)
   */
  JAL.sendSelected = async function() {
    const selected = JAL.state.comments.filter(c => JAL.state.selectedComments.has(c.commentId));

    if (selected.length === 0) {
      alert('No comments selected. Please select comments to send.');
      return;
    }

    // Create jump frame
    const currentMessage = JAL.state.comments[0]?.anchor?.messageFingerprint;
    const frame = JAL.Storage.createJumpFrame(
      currentMessage,
      JAL.state.adapter.getScrollPosition(),
      selected.map(c => c.commentId)
    );

    // Push to stack
    await JAL.Storage.pushJump(JAL.state.pageId, frame);

    // Set pending jump to detect the response
    JAL.state.pendingJump = frame;

    // Compose the prompt
    const prompt = JAL.composePrompt(selected);

    // Insert into composer
    const success = JAL.state.adapter.insertIntoComposer(prompt);

    if (success) {
      // Mark comments as queued
      for (const comment of selected) {
        await JAL.Storage.updateComment(comment.commentId, { status: 'queued' });
        const idx = JAL.state.comments.findIndex(c => c.commentId === comment.commentId);
        if (idx !== -1) {
          JAL.state.comments[idx].status = 'queued';
        }
      }

      JAL.UI.renderComments();

      // Clear selection
      JAL.state.selectedComments.clear();
    } else {
      alert('Could not insert into composer. Please paste manually:\n\n' + prompt);
    }
  };

  /**
   * Compose a prompt from selected comments
   */
  JAL.composePrompt = function(comments) {
    // Normalize whitespace: collapse all whitespace (spaces, newlines, tabs) to single space
    const normalize = (text) => text ? text.replace(/\s+/g, ' ').trim() : '';

    let prompt = "";

    comments.forEach((comment, idx) => {
      const anchor = comment.anchor;
      const quote = normalize(anchor.quoteExact);

      // Use contextSentences (complete sentences containing the quote)
      let context = normalize(anchor.contextSentences);
      if (!context) {
        context = "(context not captured)";
      }

      prompt += `#${idx + 1}\n`;
      prompt += `Context:\n`;
      prompt += `In your previous response, you were discussing:\n`;
      prompt += `"${context}"\n\n`;
      prompt += `Focus:\n`;
      prompt += `I am referring specifically to:\n`;
      prompt += `"${quote}"\n\n`;
      prompt += `Follow-up:\n`;
      prompt += `Respond to my comment below:\n`;
      prompt += `${comment.body}\n\n`;
    });

    return prompt.trim();
  };

  /**
   * Add a single comment to the composer (for incremental building)
   */
  JAL.addCommentToComposer = function(commentId) {
    // Check if already in composer
    if (JAL.state.commentsInComposer.has(commentId)) {
      console.log('JAL: Comment already in composer');
      return;
    }

    const comment = JAL.state.comments.find(c => c.commentId === commentId);
    if (!comment) {
      console.log('JAL: Comment not found');
      return;
    }

    const adapter = JAL.state.adapter;
    const existingContent = adapter.getComposerContent ? adapter.getComposerContent() : '';

    // Normalize whitespace helper
    const normalize = (text) => text ? text.replace(/\s+/g, ' ').trim() : '';

    const anchor = comment.anchor;
    const quote = normalize(anchor.quoteExact);
    let context = normalize(anchor.contextSentences);
    if (!context) {
      context = "(context not captured)";
    }

    // Check if there's already JAL content in the composer
    // Look for the pattern "#1\n" or "#2\n" etc.
    const jalPattern = /#(\d+)\n/g;
    const matches = [...existingContent.matchAll(jalPattern)];

    let nextNumber = 1;
    let promptText = '';

    if (matches.length > 0) {
      // Find the highest number
      const numbers = matches.map(m => parseInt(m[1], 10));
      nextNumber = Math.max(...numbers) + 1;

      // Add new comment entry (compressed symbolic format) - one blank line before
      promptText = `\n#${nextNumber}\n`;
      promptText += `【${context}】\n`;
      promptText += `→"${quote}"：${comment.body}`;
    } else {
      // First comment (compressed symbolic format)
      promptText = `#1\n`;
      promptText += `【${context}】\n`;
      promptText += `→"${quote}"：${comment.body}`;
    }

    // Append to composer
    const success = adapter.appendToComposer ? adapter.appendToComposer(promptText) : adapter.insertIntoComposer(promptText);

    if (success) {
      console.log(`JAL: Added comment #${nextNumber} to composer`);

      // Track that this comment is now in the composer
      JAL.state.commentsInComposer.add(commentId);

      // Update visual state
      JAL.UI.updateCommentVisualState(commentId, 'added');

      // Close the popup after adding
      JAL.UI.hideCommentPopup();
    } else {
      alert('Could not add to composer. Please copy manually:\n\n' + promptText);
    }
  };

  /**
   * Check if a comment is currently in the composer
   */
  JAL.isCommentInComposer = function(commentId) {
    return JAL.state.commentsInComposer.has(commentId);
  };

  /**
   * Get the visual state of a comment
   * Returns: 'draft' (orange), 'added' (blue), or 'asked' (green)
   */
  JAL.getCommentVisualState = function(commentId) {
    // Currently in composer = blue (added)
    if (JAL.state.commentsInComposer.has(commentId)) {
      return 'added';
    }

    // Check stored status
    const comment = JAL.state.comments.find(c => c.commentId === commentId);
    if (!comment) return 'draft';

    // Asked = status is queued or sent (set when transitioning from added)
    if (comment.status === 'queued' || comment.status === 'sent') {
      return 'asked';
    }

    // Default is draft
    return 'draft';
  };

  /**
   * Check if a comment's content appears in any user message as a JAL prompt
   */
  JAL.isCommentInUserMessages = function(comment) {
    if (!JAL.state.adapter.getAllUserMessageText) return false;

    const userMessagesText = JAL.state.adapter.getAllUserMessageText();
    if (!userMessagesText) return false;

    const commentBody = comment.body.trim();
    if (!commentBody) return false;

    // Look for the new compressed format: →"quote"：{comment body}
    const jalPattern = `：${commentBody}`;
    if (userMessagesText.includes(jalPattern)) {
      return true;
    }

    // Also check old format for backwards compatibility
    const oldPattern = `Respond to my comment below:\n${commentBody}`;
    if (userMessagesText.includes(oldPattern)) {
      return true;
    }

    return false;
  };

  /**
   * Called when composer is cleared - check if comments were actually sent
   */
  JAL.clearComposerTracking = function() {
    console.log('JAL: clearComposerTracking called, comments in composer:', JAL.state.commentsInComposer.size);

    for (const commentId of JAL.state.commentsInComposer) {
      const comment = JAL.state.comments.find(c => c.commentId === commentId);
      if (comment) {
        // Check if the comment was actually sent by looking at user messages
        const wasFound = JAL.isCommentInUserMessages(comment);
        console.log('JAL: Comment', commentId, 'found in user messages:', wasFound);

        if (wasFound) {
          // It was sent! Mark as asked
          console.log('JAL: Marking comment as asked (queued)');
          comment.status = 'queued';
          JAL.Storage.updateComment(commentId, { status: 'queued' });
          JAL.UI.updateCommentVisualState(commentId, 'asked');
        } else {
          // Not found in user messages - but if composer was cleared,
          // the message was likely sent. Mark as asked anyway since
          // the composer had JAL content and was cleared (indicating send)
          console.log('JAL: Comment not found in DOM but composer was cleared - marking as asked');
          comment.status = 'queued';
          JAL.Storage.updateComment(commentId, { status: 'queued' });
          JAL.UI.updateCommentVisualState(commentId, 'asked');
        }
      }
    }
    JAL.state.commentsInComposer.clear();
  };

  /**
   * Called when a message is actually sent - mark added comments as asked
   */
  JAL.markComposerCommentsSent = function() {
    // Mark all "added" comments as "asked" (queued) since they were actually sent
    for (const commentId of JAL.state.commentsInComposer) {
      const comment = JAL.state.comments.find(c => c.commentId === commentId);
      if (comment && comment.status === 'draft') {
        comment.status = 'queued';
        JAL.Storage.updateComment(commentId, { status: 'queued' });
      }
      JAL.UI.updateCommentVisualState(commentId, 'asked');
    }
    JAL.state.commentsInComposer.clear();
  };

  /**
   * Jump return (JR) - go back to where we were
   */
  JAL.jumpReturn = async function() {
    const result = await JAL.Storage.popJump(JAL.state.pageId);

    if (!result.success || !result.frame) {
      console.log('JAL: No jump history');
      return;
    }

    const frame = result.frame;

    // Find the original message by fingerprint
    const messages = JAL.state.adapter.getAssistantMessages();
    const targetMessage = messages.find(m =>
      m.getAttribute('data-jal-message') === frame.fromBlockFp
    );

    if (targetMessage) {
      JAL.Utils.scrollToElement(targetMessage, 100);
      JAL.Utils.flashHighlight(targetMessage);
    } else {
      // Fallback to scroll position
      JAL.state.adapter.scrollToPosition(frame.fromScrollY);
    }
  };

  // ===== UI Module =====

  JAL.UI = {
    /**
     * Create the main overlay UI
     */
    createOverlay() {
      const container = document.createElement('div');
      container.id = 'jal-container';
      container.innerHTML = `
        <div id="jal-panel" class="jal-panel jal-hidden">
          <div class="jal-panel-header">
            <h3>JAL Comments</h3>
            <div class="jal-panel-actions">
              <button class="jal-btn jal-btn-primary" id="jal-send-btn" title="Send Selected (Alt+J)">
                JAL Send
              </button>
              <button class="jal-btn" id="jal-return-btn" title="Jump Return (Alt+R)">
                JR
              </button>
              <button class="jal-btn jal-btn-close" id="jal-close-btn">×</button>
            </div>
          </div>
          <div class="jal-panel-content" id="jal-comments-list">
            <p class="jal-empty">No comments yet. Select text and click "+ Comment" to add one.</p>
          </div>
        </div>
        <button id="jal-toggle-btn" class="jal-toggle-btn" title="Toggle JAL Panel (Alt+G)">
          <span>💬</span>
        </button>
        <button id="jal-floating-btn" class="jal-floating-btn jal-hidden">Add Comment</button>
        <div id="jal-comment-input" class="jal-comment-input jal-hidden">
          <textarea id="jal-comment-textarea" placeholder="Enter your comment (or just '?')"></textarea>
          <div class="jal-input-actions">
            <button class="jal-btn" id="jal-cancel-comment">Cancel</button>
            <button class="jal-btn jal-btn-primary" id="jal-save-comment">Save</button>
          </div>
        </div>
      `;

      document.body.appendChild(container);
      JAL.state.ui.container = container;

      // Event listeners
      document.getElementById('jal-toggle-btn').addEventListener('click', () => this.togglePanel());
      document.getElementById('jal-close-btn').addEventListener('click', () => this.togglePanel());
      document.getElementById('jal-send-btn').addEventListener('click', () => JAL.sendSelected());
      document.getElementById('jal-return-btn').addEventListener('click', () => JAL.jumpReturn());
      document.getElementById('jal-floating-btn').addEventListener('click', () => JAL.addCommentFromSelection());
      document.getElementById('jal-save-comment').addEventListener('click', () => this.saveCommentFromInput());
      document.getElementById('jal-cancel-comment').addEventListener('click', () => this.hideCommentInput());
    },

    /**
     * Debug helper (disabled - call manually if needed)
     */
    debugStyles() {
      // Disabled to reduce console noise
    },

    /**
     * Toggle the panel visibility
     */
    togglePanel() {
      const panel = document.getElementById('jal-panel');
      panel.classList.toggle('jal-hidden');

      // Reposition comments when panel becomes visible
      if (!panel.classList.contains('jal-hidden')) {
        setTimeout(() => this.positionComments(), 100);
      }
    },

    /**
     * Show the floating "+ Comment" button attached to the message element
     */
    showFloatingButton(selectionRect, messageElement) {
      const btn = document.getElementById('jal-floating-btn');
      if (!btn) return;

      // Ensure message element has relative positioning
      if (getComputedStyle(messageElement).position === 'static') {
        messageElement.style.position = 'relative';
      }

      // Move button inside the message element if not already there
      if (btn.parentElement !== messageElement) {
        messageElement.appendChild(btn);
      }

      // Position relative to message element
      const messageRect = messageElement.getBoundingClientRect();
      const relativeLeft = selectionRect.right - messageRect.left + 10;
      const relativeTop = selectionRect.top - messageRect.top;

      btn.style.position = 'absolute';
      btn.style.left = `${relativeLeft}px`;
      btn.style.top = `${relativeTop}px`;
      btn.classList.remove('jal-hidden');
    },

    /**
     * Hide the floating button
     */
    hideFloatingButton() {
      const btn = document.getElementById('jal-floating-btn');
      if (btn) {
        btn.classList.add('jal-hidden');
      }
    },

    /**
     * Show comment input near anchor
     */
    showCommentInput(anchor, messageElement) {
      this.pendingAnchor = anchor;
      this.pendingMessage = messageElement;

      const input = document.getElementById('jal-comment-input');
      const textarea = document.getElementById('jal-comment-textarea');

      // Keep input in jal-container (not inside message) to avoid clipping
      const jalContainer = document.getElementById('jal-container');
      if (input.parentElement !== jalContainer) {
        jalContainer.appendChild(input);
      }

      // Create range from anchor (this uses the expanded quoteExact, not original selection)
      const expandedRange = JAL.Anchoring.createRangeForAnchor(anchor, messageElement);

      if (expandedRange) {
        const rect = expandedRange.getBoundingClientRect();
        const inputWidth = 280; // matches CSS
        const inputHeight = 150; // approximate

        // Position to the right of the selection (same as comment popup)
        let left = rect.right + 10;
        let top = rect.top;

        // Flip to left side if not enough space on right
        if (left + inputWidth > window.innerWidth - 20) {
          left = rect.left - inputWidth - 10;
        }
        if (left < 20) left = 20;

        // Clamp to viewport bounds
        if (top + inputHeight > window.innerHeight - 20) {
          top = window.innerHeight - inputHeight - 20;
        }
        if (top < 20) top = 20;

        input.style.position = 'fixed';
        input.style.left = `${left}px`;
        input.style.right = 'auto';
        input.style.top = `${top}px`;

        // Create temporary highlight using the expanded range (covers full words/equations)
        this.pendingHighlights = this.highlightRange(expandedRange, 'jal-pending');
      }

      // Clear the original selection
      window.getSelection().removeAllRanges();

      input.classList.remove('jal-hidden');
      textarea.value = '';
      textarea.focus({ preventScroll: true });
      this.hideFloatingButton();
    },

    /**
     * Hide comment input and remove temporary highlight if cancelled
     */
    hideCommentInput() {
      const input = document.getElementById('jal-comment-input');
      input.classList.add('jal-hidden');

      // Remove temporary highlights
      this.removePendingHighlights();

      this.pendingAnchor = null;
      this.pendingMessage = null;
    },

    /**
     * Remove temporary pending highlights
     */
    removePendingHighlights() {
      // Remove all pending overlay elements
      document.querySelectorAll('.jal-highlight-overlay[data-comment-id="jal-pending"], .jal-underline[data-comment-id="jal-pending"], .jal-click-overlay[data-comment-id="jal-pending"]').forEach(el => {
        el.remove();
      });

      this.pendingHighlights = null;
    },

    /**
     * Merge pending highlights into final highlights
     * Uses the exact positions from debug view, applies merging, creates new elements
     */
    mergePendingHighlights(commentId) {
      const pendingEls = document.querySelectorAll('.jal-highlight-overlay[data-comment-id="jal-pending"]');
      if (pendingEls.length === 0) return [];

      // Get the message element (parent of first pending highlight)
      const messageElement = pendingEls[0].parentElement;
      // Set up stacking context so z-index -1 works (highlight behind text)
      messageElement.style.isolation = 'isolate';
      const messageRect = messageElement.getBoundingClientRect();

      // Extract positions from pending highlights (these are the accurate debug rects)
      let lines = [];
      pendingEls.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          lines.push({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom
          });
        }
      });

      // Remove all pending elements
      document.querySelectorAll('.jal-highlight-overlay[data-comment-id="jal-pending"], .jal-underline[data-comment-id="jal-pending"], .jal-click-overlay[data-comment-id="jal-pending"]').forEach(el => {
        el.remove();
      });
      this.pendingHighlights = null;

      if (lines.length === 0) return [];

      console.log(`JAL MERGE: ${lines.length} debug rects -> merging...`);

      // Apply merging: group by same line (centers within half smaller height)
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < lines.length; i++) {
          for (let j = i + 1; j < lines.length; j++) {
            const a = lines[i];
            const b = lines[j];

            const centerA = (a.top + a.bottom) / 2;
            const centerB = (b.top + b.bottom) / 2;
            const heightA = a.bottom - a.top;
            const heightB = b.bottom - b.top;
            const smallerHeight = Math.min(heightA, heightB);
            const centerDistance = Math.abs(centerA - centerB);

            const sameLine = centerDistance < smallerHeight / 2;

            if (sameLine) {
              const merged = {
                left: Math.min(a.left, b.left),
                right: Math.max(a.right, b.right),
                top: Math.min(a.top, b.top),
                bottom: Math.max(a.bottom, b.bottom)
              };
              lines.splice(j, 1);
              lines.splice(i, 1);
              lines.push(merged);
              changed = true;
              break;
            }
          }
          if (changed) break;
        }
      }

      console.log(`JAL MERGE: -> ${lines.length} merged lines`);

      // Create final highlight elements
      const highlights = [];
      for (const line of lines) {
        const lineHeight = line.bottom - line.top;
        const lineWidth = line.right - line.left;
        const relativeTop = line.top - messageRect.top;
        const relativeLeft = line.left - messageRect.left;

        const highlight = document.createElement('div');
        highlight.className = 'jal-highlight-overlay';
        highlight.dataset.commentId = commentId;
        highlight.style.cssText = `
          position: absolute;
          left: ${relativeLeft}px;
          top: ${relativeTop}px;
          width: ${lineWidth}px;
          height: ${lineHeight}px;
          background-color: rgba(255, 220, 100, 0.35);
          pointer-events: none;
          z-index: -1;
        `;

        messageElement.appendChild(highlight);
        highlights.push(highlight);

        // Create thin underline (visual indicator only)
        const underline = document.createElement('div');
        underline.className = 'jal-underline';
        underline.dataset.commentId = commentId;
        underline.style.cssText = `
          position: absolute;
          left: ${relativeLeft}px;
          top: ${relativeTop + lineHeight - 2}px;
          width: ${lineWidth}px;
          height: 2px;
          background-color: #f6ad55;
          pointer-events: none;
          z-index: 1;
        `;
        messageElement.appendChild(underline);
        highlights.push(underline);

        // Create transparent click overlay (covers entire highlight area)
        const clickOverlay = document.createElement('div');
        clickOverlay.className = 'jal-click-overlay';
        clickOverlay.dataset.commentId = commentId;
        clickOverlay.style.cssText = `
          position: absolute;
          left: ${relativeLeft}px;
          top: ${relativeTop}px;
          width: ${lineWidth}px;
          height: ${lineHeight}px;
          background-color: transparent;
          pointer-events: auto;
          cursor: pointer;
          z-index: 2;
        `;

        clickOverlay.addEventListener('click', (e) => {
          e.stopPropagation();
          JAL.UI.showCommentPopup(commentId, e.clientX, e.clientY);
        });

        clickOverlay.addEventListener('mouseenter', (e) => {
          const cid = e.target.dataset.commentId;
          document.querySelectorAll(`.jal-highlight-overlay[data-comment-id="${cid}"], .jal-underline[data-comment-id="${cid}"]`).forEach(el => {
            el.classList.add('jal-hover');
          });
        });
        clickOverlay.addEventListener('mouseleave', (e) => {
          const cid = e.target.dataset.commentId;
          document.querySelectorAll(`.jal-highlight-overlay[data-comment-id="${cid}"], .jal-underline[data-comment-id="${cid}"]`).forEach(el => {
            el.classList.remove('jal-hover');
          });
        });

        messageElement.appendChild(clickOverlay);
        highlights.push(clickOverlay);
      }

      return highlights;
    },

    /**
     * Save comment from input
     */
    async saveCommentFromInput() {
      const textarea = document.getElementById('jal-comment-textarea');
      const body = textarea.value.trim();

      if (!body) {
        alert('Please enter a comment');
        return;
      }

      if (this.pendingAnchor) {
        // Save the comment and get the new commentId
        const comment = JAL.Storage.createComment(
          JAL.state.pageId,
          this.pendingAnchor,
          body,
          { status: 'draft' }
        );

        await JAL.Storage.saveComment(comment);
        JAL.state.comments.push(comment);

        // Convert pending highlights to permanent ones (already merged, just rename)
        if (this.pendingHighlights && this.pendingHighlights.length > 0) {
          this.pendingHighlights.forEach(el => {
            el.dataset.commentId = comment.commentId;
            // Add click handler to click overlay elements (they handle all interactions)
            if (el.classList.contains('jal-click-overlay')) {
              el.addEventListener('click', (e) => {
                e.stopPropagation();
                JAL.UI.showCommentPopup(comment.commentId, e.clientX, e.clientY);
              });
              el.addEventListener('mouseenter', () => {
                document.querySelectorAll(`.jal-highlight-overlay[data-comment-id="${comment.commentId}"], .jal-underline[data-comment-id="${comment.commentId}"]`).forEach(h => h.classList.add('jal-hover'));
              });
              el.addEventListener('mouseleave', () => {
                document.querySelectorAll(`.jal-highlight-overlay[data-comment-id="${comment.commentId}"], .jal-underline[data-comment-id="${comment.commentId}"]`).forEach(h => h.classList.remove('jal-hover'));
              });
            }
          });
          JAL.state.ui.highlights.set(comment.commentId, this.pendingHighlights);
          this.pendingHighlights = null;
        }

        // Render comments list only (highlights are already created)
        this.renderCommentsOnly();

        // Clear selection
        window.getSelection().removeAllRanges();

        // Hide the input
        this.hideCommentInputWithoutRemovingHighlights();

        // Show the comment popup (will position itself based on highlight)
        this.showCommentPopup(comment.commentId, 0, 0);

        return; // Exit early since we handled hiding
      }

      this.hideCommentInputWithoutRemovingHighlights();
    },

    /**
     * Render only the comments list, without re-rendering highlights
     */
    renderCommentsOnly() {
      const list = document.getElementById('jal-comments-list');
      const comments = JAL.state.comments;

      if (comments.length === 0) {
        list.innerHTML = '<p class="jal-empty">No comments yet. Select text and click "+ Comment" to add one.</p>';
        return;
      }

      // Create comment cards
      list.innerHTML = comments.map(comment => `
        <div class="jal-comment-card ${comment.status}" data-comment-id="${comment.commentId}">
          <div class="jal-comment-header">
            <label class="jal-checkbox">
              <input type="checkbox" ${JAL.state.selectedComments.has(comment.commentId) ? 'checked' : ''}>
              <span class="jal-status-badge">${comment.status}</span>
            </label>
            <button class="jal-btn-icon jal-delete-btn" title="Delete">×</button>
          </div>
          <div class="jal-comment-quote">"${this.escapeHtml(comment.anchor.quoteExact.slice(0, 50))}${comment.anchor.quoteExact.length > 50 ? '...' : ''}"</div>
          <div class="jal-comment-body">${this.escapeHtml(comment.body)}</div>
        </div>
      `).join('');

      // Add event listeners (same as renderComments)
      list.querySelectorAll('.jal-comment-card').forEach(card => {
        const commentId = card.dataset.commentId;

        card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
          if (e.target.checked) {
            JAL.state.selectedComments.add(commentId);
          } else {
            JAL.state.selectedComments.delete(commentId);
          }
        });

        card.querySelector('.jal-delete-btn').addEventListener('click', async () => {
          await JAL.Storage.deleteComment(commentId);
          JAL.state.comments = JAL.state.comments.filter(c => c.commentId !== commentId);
          JAL.state.selectedComments.delete(commentId);
          this.renderComments();
          this.renderHighlights();
        });

        card.querySelector('.jal-comment-quote').addEventListener('click', () => {
          const highlight = JAL.state.ui.highlights.get(commentId);
          if (highlight && highlight.length > 0) {
            JAL.Utils.scrollToElement(highlight[0], 100);
            highlight.forEach(el => el.classList.add('jal-flash'));
            setTimeout(() => highlight.forEach(el => el.classList.remove('jal-flash')), 2000);
          }
        });

        card.addEventListener('mouseenter', () => {
          const highlights = JAL.state.ui.highlights.get(commentId);
          if (highlights) {
            highlights.forEach(el => el.classList.add('jal-active'));
          }
        });

        card.addEventListener('mouseleave', () => {
          const highlights = JAL.state.ui.highlights.get(commentId);
          if (highlights) {
            highlights.forEach(el => el.classList.remove('jal-active'));
          }
        });
      });

      // Position comments
      requestAnimationFrame(() => {
        this.positionComments();
      });
    },

    /**
     * Hide comment input without removing highlights (used after successful save)
     */
    hideCommentInputWithoutRemovingHighlights() {
      const input = document.getElementById('jal-comment-input');
      input.classList.add('jal-hidden');
      this.pendingAnchor = null;
      this.pendingMessage = null;
      // Don't remove pendingHighlights - they've been converted to permanent
    },

    /**
     * Show comment popup when clicking a highlight
     */
    showCommentPopup(commentId, x, y) {
      // Remove any existing popup
      this.hideCommentPopup();

      // Find the comment
      const comment = JAL.state.comments.find(c => c.commentId === commentId);
      if (!comment) return;

      // Get the highlight element to anchor the popup to
      const highlights = JAL.state.ui.highlights.get(commentId);
      const highlightEl = highlights && highlights.length > 0 ? highlights[0] : null;

      // Get visual state: draft (orange), added (blue), asked (green)
      const visualState = JAL.getCommentVisualState(commentId);
      const isInComposer = visualState === 'added';
      const isAsked = visualState === 'asked';
      const canAdd = visualState === 'draft'; // Only draft can be added
      const canEdit = !isInComposer; // Can edit if not currently in composer

      // Status label for display
      const statusLabels = {
        'draft': 'draft',
        'added': 'added',
        'asked': 'asked'
      };
      const statusLabel = statusLabels[visualState] || comment.status;

      // Tooltip for add button
      let addTooltip = 'Add to chat';
      if (isInComposer) addTooltip = 'Already in chat';
      else if (isAsked) addTooltip = 'Already asked - edit to ask again';

      // Create popup
      const popup = document.createElement('div');
      popup.className = `jal-comment-popup jal-state-${visualState}`;
      popup.id = 'jal-comment-popup';
      popup.dataset.commentId = commentId;
      popup.innerHTML = `
        <div class="jal-popup-header">
          <span class="jal-status-badge">${statusLabel}</span>
          <button class="jal-popup-delete-btn" title="Delete comment">🗑</button>
          <button class="jal-popup-close">&times;</button>
        </div>
        <div class="jal-popup-body">${this.escapeHtml(comment.body)}</div>
        <button class="jal-popup-edit-btn ${!canEdit ? 'jal-disabled' : ''}" title="${!canEdit ? 'Cannot edit while in chat' : 'Edit comment'}" ${!canEdit ? 'disabled' : ''}>✎</button>
        <button class="jal-popup-add-btn ${!canAdd ? 'jal-disabled' : ''}" title="${addTooltip}" ${!canAdd ? 'disabled' : ''}>+</button>
      `;

      // Use fixed positioning so popup follows the highlight on scroll
      popup.style.position = 'fixed';

      document.body.appendChild(popup);

      // Function to position popup relative to highlight
      const positionPopup = () => {
        if (!highlightEl) {
          // Fallback to click position if no highlight
          popup.style.left = `${x + 10}px`;
          popup.style.top = `${y + 10}px`;
          return;
        }

        const rect = highlightEl.getBoundingClientRect();

        // Hide popup if highlight is out of view
        const isVisible = rect.bottom > 0 && rect.top < window.innerHeight;
        if (!isVisible) {
          popup.style.display = 'none';
          return;
        }
        popup.style.display = '';

        const popupWidth = popup.offsetWidth || 300;
        const popupHeight = popup.offsetHeight || 150;

        // Position to the right of the highlight
        let left = rect.right + 10;
        let top = rect.top;

        // Flip to left side if not enough space on right
        if (left + popupWidth > window.innerWidth - 20) {
          left = rect.left - popupWidth - 10;
        }
        if (left < 20) left = 20;

        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
      };

      // Initial position
      positionPopup();

      // Update position on scroll
      const scrollContainer = this.findScrollContainer();
      this._popupScrollHandler = () => {
        requestAnimationFrame(positionPopup);
      };

      window.addEventListener('scroll', this._popupScrollHandler, { passive: true });
      if (scrollContainer && scrollContainer !== window) {
        scrollContainer.addEventListener('scroll', this._popupScrollHandler, { passive: true });
      }
      this._popupScrollContainer = scrollContainer;

      // Close button
      popup.querySelector('.jal-popup-close').addEventListener('click', () => {
        this.hideCommentPopup();
      });

      // Edit button (only if can edit)
      const editBtn = popup.querySelector('.jal-popup-edit-btn');
      if (canEdit) {
        editBtn.addEventListener('click', () => {
          this.showEditMode(popup, commentId, comment, visualState);
        });
      }

      // Add to composer button (only if draft)
      const addBtn = popup.querySelector('.jal-popup-add-btn');
      if (canAdd) {
        addBtn.addEventListener('click', () => {
          JAL.addCommentToComposer(commentId);
        });
      }

      // Delete button
      const deleteBtn = popup.querySelector('.jal-popup-delete-btn');
      deleteBtn.addEventListener('click', async () => {
        if (confirm('Delete this comment?')) {
          // Remove from storage
          await JAL.Storage.deleteComment(commentId);

          // Remove from state
          const idx = JAL.state.comments.findIndex(c => c.commentId === commentId);
          if (idx !== -1) JAL.state.comments.splice(idx, 1);

          // Remove from composer set if present
          JAL.state.commentsInComposer.delete(commentId);

          // Remove highlights
          const highlights = JAL.state.ui.highlights.get(commentId);
          if (highlights) {
            highlights.forEach(el => el.remove());
            JAL.state.ui.highlights.delete(commentId);
          }

          // Close popup
          this.hideCommentPopup();

          // Re-render comments list
          this.renderCommentsOnly();
        }
      });

      // Close on click outside
      setTimeout(() => {
        document.addEventListener('click', this._popupClickOutside = (e) => {
          if (!popup.contains(e.target) && !e.target.classList.contains('jal-highlight-overlay')) {
            this.hideCommentPopup();
          }
        });
      }, 10);
    },

    /**
     * Show edit mode in the popup
     */
    showEditMode(popup, commentId, comment, previousState) {
      const body = popup.querySelector('.jal-popup-body');
      const editBtn = popup.querySelector('.jal-popup-edit-btn');
      const addBtn = popup.querySelector('.jal-popup-add-btn');

      // Add edit mode class to reduce bottom padding
      popup.classList.add('jal-edit-mode');

      // Replace body with textarea
      const textarea = document.createElement('textarea');
      textarea.className = 'jal-popup-edit-textarea';
      textarea.value = comment.body;
      body.replaceWith(textarea);
      textarea.focus();
      textarea.select();

      // Hide edit and add buttons, show save/cancel
      editBtn.style.display = 'none';
      addBtn.style.display = 'none';

      const actions = document.createElement('div');
      actions.className = 'jal-popup-edit-actions';
      actions.innerHTML = `
        <button class="jal-popup-cancel-btn">Cancel</button>
        <button class="jal-popup-save-btn">Save</button>
      `;
      popup.appendChild(actions);

      // Save handler
      actions.querySelector('.jal-popup-save-btn').addEventListener('click', async () => {
        const newBody = textarea.value.trim();
        if (!newBody) {
          alert('Comment cannot be empty');
          return;
        }

        // Update the comment
        comment.body = newBody;

        // If it was "asked" (green), reset to "draft" (orange)
        if (previousState === 'asked') {
          comment.status = 'draft';
          await JAL.Storage.updateComment(commentId, { body: newBody, status: 'draft' });
          JAL.UI.updateCommentVisualState(commentId, 'draft');
        } else {
          await JAL.Storage.updateComment(commentId, { body: newBody });
        }

        // Refresh the popup (position will be calculated from highlight)
        this.hideCommentPopup();
        this.showCommentPopup(commentId, 0, 0);
      });

      // Cancel handler
      actions.querySelector('.jal-popup-cancel-btn').addEventListener('click', () => {
        // Refresh the popup to original state (position will be calculated from highlight)
        this.hideCommentPopup();
        this.showCommentPopup(commentId, 0, 0);
      });
    },

    /**
     * Hide comment popup
     */
    hideCommentPopup() {
      const popup = document.getElementById('jal-comment-popup');
      if (popup) popup.remove();
      if (this._popupClickOutside) {
        document.removeEventListener('click', this._popupClickOutside);
        this._popupClickOutside = null;
      }
      // Clean up scroll listeners
      if (this._popupScrollHandler) {
        window.removeEventListener('scroll', this._popupScrollHandler);
        if (this._popupScrollContainer && this._popupScrollContainer !== window) {
          this._popupScrollContainer.removeEventListener('scroll', this._popupScrollHandler);
        }
        this._popupScrollHandler = null;
        this._popupScrollContainer = null;
      }
    },

    /**
     * Update the visual state of a comment (highlights and underlines)
     * States: 'draft' (orange), 'added' (blue), 'asked' (green)
     */
    updateCommentVisualState(commentId, state) {
      const highlights = JAL.state.ui.highlights.get(commentId);
      if (!highlights) return;

      // Color mapping for each state
      const colors = {
        draft: { highlight: 'rgba(255, 220, 100, 0.5)', underline: '#f6ad55' },  // orange
        added: { highlight: 'rgba(100, 180, 255, 0.5)', underline: '#4299e1' },  // blue
        asked: { highlight: 'rgba(100, 220, 150, 0.5)', underline: '#48bb78' }   // green
      };

      const colorSet = colors[state] || colors.draft;

      highlights.forEach(el => {
        if (el.classList.contains('jal-highlight-overlay')) {
          el.style.backgroundColor = colorSet.highlight;
          el.dataset.visualState = state;
        } else if (el.classList.contains('jal-underline')) {
          el.style.backgroundColor = colorSet.underline;
          el.dataset.visualState = state;
        }
      });
    },

    /**
     * Render comments in the margin, aligned with their highlights
     */
    renderComments() {
      const list = document.getElementById('jal-comments-list');
      const comments = JAL.state.comments;

      if (comments.length === 0) {
        list.innerHTML = '<p class="jal-empty">No comments yet. Select text and click "+ Comment" to add one.</p>';
        return;
      }

      // Create comment cards (without positioning yet)
      list.innerHTML = comments.map(comment => `
        <div class="jal-comment-card ${comment.status}" data-comment-id="${comment.commentId}">
          <div class="jal-comment-header">
            <label class="jal-checkbox">
              <input type="checkbox" ${JAL.state.selectedComments.has(comment.commentId) ? 'checked' : ''}>
              <span class="jal-status-badge">${comment.status}</span>
            </label>
            <button class="jal-btn-icon jal-delete-btn" title="Delete">×</button>
          </div>
          <div class="jal-comment-quote">"${this.escapeHtml(comment.anchor.quoteExact.slice(0, 50))}${comment.anchor.quoteExact.length > 50 ? '...' : ''}"</div>
          <div class="jal-comment-body">${this.escapeHtml(comment.body)}</div>
        </div>
      `).join('');

      // Add event listeners
      list.querySelectorAll('.jal-comment-card').forEach(card => {
        const commentId = card.dataset.commentId;

        // Checkbox toggle
        card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
          if (e.target.checked) {
            JAL.state.selectedComments.add(commentId);
          } else {
            JAL.state.selectedComments.delete(commentId);
          }
        });

        // Delete button
        card.querySelector('.jal-delete-btn').addEventListener('click', async () => {
          await JAL.Storage.deleteComment(commentId);
          JAL.state.comments = JAL.state.comments.filter(c => c.commentId !== commentId);
          JAL.state.selectedComments.delete(commentId);
          this.renderComments();
          this.renderHighlights();
        });

        // Click to scroll to highlight
        card.querySelector('.jal-comment-quote').addEventListener('click', () => {
          const highlight = JAL.state.ui.highlights.get(commentId);
          if (highlight && highlight.length > 0) {
            JAL.Utils.scrollToElement(highlight[0], 100);
            highlight.forEach(el => el.classList.add('jal-flash'));
            setTimeout(() => highlight.forEach(el => el.classList.remove('jal-flash')), 2000);
          }
        });

        // Hover to highlight the corresponding text
        card.addEventListener('mouseenter', () => {
          const highlights = JAL.state.ui.highlights.get(commentId);
          if (highlights) {
            highlights.forEach(el => el.classList.add('jal-active'));
          }
        });

        card.addEventListener('mouseleave', () => {
          const highlights = JAL.state.ui.highlights.get(commentId);
          if (highlights) {
            highlights.forEach(el => el.classList.remove('jal-active'));
          }
        });
      });

      // Position comments after rendering highlights
      // (Called from renderHighlights after highlights are created)
    },

    /**
     * Position comment cards in the margin aligned with their highlights
     */
    positionComments() {
      // Skip if panel is hidden - no need to reposition invisible cards
      const panel = document.getElementById('jal-panel');
      if (!panel || panel.classList.contains('jal-hidden')) return;

      const list = document.getElementById('jal-comments-list');
      const cards = list.querySelectorAll('.jal-comment-card');
      const positions = [];

      cards.forEach(card => {
        const commentId = card.dataset.commentId;
        const highlights = JAL.state.ui.highlights.get(commentId);

        if (highlights && highlights.length > 0) {
          // getBoundingClientRect returns viewport-relative position
          // Since our container is position:fixed, we use viewport-relative positions directly
          const rect = highlights[0].getBoundingClientRect();
          let targetTop = rect.top;
          if (targetTop < 8) targetTop = 8;

          positions.push({ card, commentId, targetTop, height: 0 });
        } else {
          card.style.display = 'none';
        }
      });

      positions.sort((a, b) => a.targetTop - b.targetTop);

      let lastBottom = 0;
      const minGap = 8;
      positions.forEach(pos => {
        pos.card.style.display = '';
        let actualTop = pos.targetTop;
        if (actualTop < lastBottom + minGap) {
          actualTop = lastBottom + minGap;
        }
        pos.card.style.top = `${actualTop}px`;
        lastBottom = actualTop + pos.card.offsetHeight;
      });
    },

    /**
     * Render highlights for all comments
     */
    renderHighlights() {
      // Clear existing highlights
      document.querySelectorAll('mark.jal-highlight').forEach(el => {
        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          parent.removeChild(el);
          parent.normalize();
        }
      });
      document.querySelectorAll('.jal-highlight-overlay, .jal-underline, .jal-click-overlay').forEach(el => el.remove());
      JAL.state.ui.highlights.clear();

      const messages = JAL.state.adapter.getAssistantMessages();

      // Mark all messages (ensure fingerprints exist before matching)
      messages.forEach(msg => {
        JAL.state.adapter.markMessage(msg);
      });

      for (const comment of JAL.state.comments) {
        const targetMessage = messages.find(m =>
          m.getAttribute('data-jal-message') === comment.anchor.messageFingerprint
        );

        if (!targetMessage) continue;

        const range = JAL.Anchoring.createRangeForAnchor(comment.anchor, targetMessage);
        if (!range) continue;

        const highlights = this.highlightRange(range, comment.commentId);
        JAL.state.ui.highlights.set(comment.commentId, highlights);

        // Set initial visual state based on comment status
        const visualState = JAL.getCommentVisualState(comment.commentId);
        this.updateCommentVisualState(comment.commentId, visualState);
      }

      requestAnimationFrame(() => {
        this.positionComments();
        this.setupPositionHandlers();
      });
    },

    /**
     * Find the scroll container that ChatGPT uses
     */
    findScrollContainer() {
      // Walk up from message to find scrolling ancestor
      const messages = JAL.state.adapter?.getAssistantMessages() || [];
      if (messages.length > 0) {
        let el = messages[0];
        while (el && el !== document.body) {
          const style = getComputedStyle(el);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            return el;
          }
          el = el.parentElement;
        }
      }

      // Fallback selectors
      const selectors = [
        '[class*="react-scroll-to-bottom"] > div',
        'main [class*="overflow-y-auto"]',
        'main [class*="overflow-auto"]',
        'main'
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          const style = getComputedStyle(el);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            return el;
          }
        }
      }
      return document.documentElement;
    },

    /**
     * Highlight a range with LINE-BY-LINE highlights
     * Groups rects by line and creates one highlight per line
     * Positions relative to the MESSAGE ELEMENT for stability
     */
    highlightRange(range, commentId) {
      const highlights = [];

      try {
        const messageElement = JAL.state.adapter.findMessageContainer(range.commonAncestorContainer);
        if (!messageElement) {
          console.log('JAL: No message element for highlight');
          return highlights;
        }

        // Set up stacking context so z-index -1 works (highlight behind text)
        if (getComputedStyle(messageElement).position === 'static') {
          messageElement.style.position = 'relative';
        }
        messageElement.style.isolation = 'isolate';
        messageElement.offsetHeight;
        const messageRect = messageElement.getBoundingClientRect();

        // Step 1: Get rects - expand partial equation selections to full equations
        // Helper: check if a node is inside an equation element
        const getEquationAncestor = (node) => {
          let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          while (el && el !== messageElement) {
            if (el.classList?.contains('katex') ||
                el.classList?.contains('math') ||
                el.tagName === 'MJX-CONTAINER' ||
                el.tagName === 'MATH' ||
                el.closest('.katex, .math, mjx-container, math')) {
              return el.closest('.katex, .math, mjx-container, math') || el;
            }
            el = el.parentElement;
          }
          return null;
        };

        // Helper: get the tight bounding rect of equation content (not the full-width container)
        const getEquationContentRect = (equationEl) => {
          let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;

          // First try: get all .base elements (KaTeX actual content)
          const bases = equationEl.querySelectorAll('.base');
          if (bases.length > 0) {
            bases.forEach(base => {
              const rect = base.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                minLeft = Math.min(minLeft, rect.left);
                minTop = Math.min(minTop, rect.top);
                maxRight = Math.max(maxRight, rect.right);
                maxBottom = Math.max(maxBottom, rect.bottom);
              }
            });
            if (minLeft !== Infinity) {
              return { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom };
            }
          }

          // Second try: use getClientRects() on the equation element
          const rects = equationEl.getClientRects();
          if (rects.length > 0) {
            for (const rect of rects) {
              if (rect.width > 0 && rect.height > 0) {
                minLeft = Math.min(minLeft, rect.left);
                minTop = Math.min(minTop, rect.top);
                maxRight = Math.max(maxRight, rect.right);
                maxBottom = Math.max(maxBottom, rect.bottom);
              }
            }
            if (minLeft !== Infinity) {
              return { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom };
            }
          }

          // Third try: find all text-containing leaf spans
          const spans = equationEl.querySelectorAll('span');
          spans.forEach(span => {
            if (span.children.length === 0 && span.textContent.trim()) {
              const rect = span.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && rect.width < 500) {
                minLeft = Math.min(minLeft, rect.left);
                minTop = Math.min(minTop, rect.top);
                maxRight = Math.max(maxRight, rect.right);
                maxBottom = Math.max(maxBottom, rect.bottom);
              }
            }
          });
          if (minLeft !== Infinity) {
            return { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom };
          }

          return equationEl.getBoundingClientRect();
        };

        const charRects = [];
        const processedEquations = new Set();

        const walker = document.createTreeWalker(
          range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentNode
            : range.commonAncestorContainer,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );

        let node;
        while (node = walker.nextNode()) {
          if (!range.intersectsNode(node)) continue;

          const equationEl = getEquationAncestor(node);

          if (equationEl) {
            // Include the WHOLE equation (but only once)
            if (processedEquations.has(equationEl)) continue;
            processedEquations.add(equationEl);

            const eqRect = getEquationContentRect(equationEl);
            const eqWidth = eqRect.right - eqRect.left;
            const eqHeight = eqRect.bottom - eqRect.top;
            if (eqWidth > 0 && eqHeight > 0) {
              charRects.push({
                left: eqRect.left,
                right: eqRect.right,
                top: eqRect.top,
                bottom: eqRect.bottom
              });
            }
          } else {
            // Regular text - character by character
            const text = node.textContent;
            if (!text || text.length === 0) continue;

            // Get the actual range boundaries for this node
            let nodeStart = 0;
            let nodeEnd = text.length;
            if (node === range.startContainer) {
              nodeStart = range.startOffset;
            }
            if (node === range.endContainer) {
              nodeEnd = range.endOffset;
            }

            for (let i = nodeStart; i < nodeEnd; i++) {
              const charRange = document.createRange();
              charRange.setStart(node, i);
              charRange.setEnd(node, Math.min(i + 1, text.length));

              const rects = charRange.getClientRects();
              for (const rect of rects) {
                if (rect.width > 0 && rect.height > 0) {
                  charRects.push({
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom
                  });
                }
              }
            }
          }
        }

        let lines = charRects;

        // If character-level detection failed, fall back to getClientRects
        if (lines.length === 0) {
          const rects = range.getClientRects();
          lines = [...rects]
            .filter(r => r.width > 0 && r.height > 0)
            .map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        }

        if (lines.length === 0) return highlights;

        // SIMPLE MERGE: Group segments on the SAME line (significant Y overlap), then bounding box per group
        // "Same line" = centers are close together (within half the height of smaller segment)
        let changed = true;
        while (changed) {
          changed = false;
          for (let i = 0; i < lines.length; i++) {
            for (let j = i + 1; j < lines.length; j++) {
              const a = lines[i];
              const b = lines[j];

              // Check if segments are on the same line:
              // Their vertical centers should be close (within half the smaller height)
              const centerA = (a.top + a.bottom) / 2;
              const centerB = (b.top + b.bottom) / 2;
              const heightA = a.bottom - a.top;
              const heightB = b.bottom - b.top;
              const smallerHeight = Math.min(heightA, heightB);
              const centerDistance = Math.abs(centerA - centerB);

              // Same line if centers are within half the smaller segment's height
              const sameLine = centerDistance < smallerHeight / 2;

              if (sameLine) {
                // Merge into bounding box: leftmost, rightmost, topmost, bottommost
                const merged = {
                  left: Math.min(a.left, b.left),
                  right: Math.max(a.right, b.right),
                  top: Math.min(a.top, b.top),
                  bottom: Math.max(a.bottom, b.bottom)
                };
                // Remove both, add merged
                lines.splice(j, 1);
                lines.splice(i, 1);
                lines.push(merged);
                changed = true;
                break;
              }
            }
            if (changed) break;
          }
        }

        // Now lines contains one bounding box per line - no going over
        for (const line of lines) {
          const lineHeight = line.bottom - line.top;
          const lineWidth = line.right - line.left;
          const relativeTop = line.top - messageRect.top;
          const relativeLeft = line.left - messageRect.left;

          // Create highlight for this line (behind text, not clickable)
          const highlight = document.createElement('div');
          highlight.className = 'jal-highlight-overlay';
          highlight.dataset.commentId = commentId;
          highlight.style.cssText = `
            position: absolute;
            left: ${relativeLeft}px;
            top: ${relativeTop}px;
            width: ${lineWidth}px;
            height: ${lineHeight}px;
            background-color: rgba(255, 220, 100, 0.35);
            pointer-events: none;
            z-index: -1;
          `;

          messageElement.appendChild(highlight);
          highlights.push(highlight);

          // Create thin underline (visual indicator only)
          const underline = document.createElement('div');
          underline.className = 'jal-underline';
          underline.dataset.commentId = commentId;
          underline.style.cssText = `
            position: absolute;
            left: ${relativeLeft}px;
            top: ${relativeTop + lineHeight - 2}px;
            width: ${lineWidth}px;
            height: 2px;
            background-color: #f6ad55;
            pointer-events: none;
            z-index: 1;
          `;
          messageElement.appendChild(underline);
          highlights.push(underline);

          // Create transparent click overlay (covers entire highlight area)
          const clickOverlay = document.createElement('div');
          clickOverlay.className = 'jal-click-overlay';
          clickOverlay.dataset.commentId = commentId;
          clickOverlay.style.cssText = `
            position: absolute;
            left: ${relativeLeft}px;
            top: ${relativeTop}px;
            width: ${lineWidth}px;
            height: ${lineHeight}px;
            background-color: transparent;
            pointer-events: auto;
            cursor: pointer;
            z-index: 2;
          `;

          clickOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            JAL.UI.showCommentPopup(commentId, e.clientX, e.clientY);
          });

          clickOverlay.addEventListener('mouseenter', (e) => {
            const cid = e.target.dataset.commentId;
            document.querySelectorAll(`.jal-highlight-overlay[data-comment-id="${cid}"], .jal-underline[data-comment-id="${cid}"]`).forEach(el => {
              el.classList.add('jal-hover');
            });
          });
          clickOverlay.addEventListener('mouseleave', (e) => {
            const cid = e.target.dataset.commentId;
            document.querySelectorAll(`.jal-highlight-overlay[data-comment-id="${cid}"], .jal-underline[data-comment-id="${cid}"]`).forEach(el => {
              el.classList.remove('jal-hover');
            });
          });

          messageElement.appendChild(clickOverlay);
          highlights.push(clickOverlay);
        }
      } catch (e) {
        console.error('JAL highlightRange error:', e);
      }

      return highlights;
    },

    /**
     * Highlight a range WITHOUT merging - shows raw character-level rects for debugging
     * Each character/segment gets its own highlight with alternating colors
     */
    highlightRangeUnmerged(range, commentId) {
      const highlights = [];

      try {
        const messageElement = JAL.state.adapter.findMessageContainer(range.commonAncestorContainer);
        if (!messageElement) {
          console.log('JAL: No message element for highlight');
          return highlights;
        }

        if (getComputedStyle(messageElement).position === 'static') {
          messageElement.style.position = 'relative';
        }
        messageElement.style.isolation = 'isolate';
        messageElement.offsetHeight;
        const messageRect = messageElement.getBoundingClientRect();

        // Helper: check if a node is inside an equation element
        const getEquationAncestor = (node) => {
          let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          while (el && el !== messageElement) {
            // Common equation selectors: KaTeX, MathJax, etc.
            if (el.classList?.contains('katex') ||
                el.classList?.contains('math') ||
                el.tagName === 'MJX-CONTAINER' ||
                el.tagName === 'MATH' ||
                el.closest('.katex, .math, mjx-container, math')) {
              // Return the outermost equation container
              return el.closest('.katex, .math, mjx-container, math') || el;
            }
            el = el.parentElement;
          }
          return null;
        };

        // Helper: get the tight bounding rect of equation content (not the full-width container)
        const getEquationContentRect = (equationEl) => {
          // Try to find the actual content element (not full-width containers)
          // KaTeX uses .base for actual content, or look for spans with content
          const contentSelectors = ['.base', '.mord', '.minner', 'svg'];

          let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;

          // First try: get all .base elements (KaTeX actual content)
          const bases = equationEl.querySelectorAll('.base');
          if (bases.length > 0) {
            bases.forEach(base => {
              const rect = base.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                minLeft = Math.min(minLeft, rect.left);
                minTop = Math.min(minTop, rect.top);
                maxRight = Math.max(maxRight, rect.right);
                maxBottom = Math.max(maxBottom, rect.bottom);
              }
            });
            if (minLeft !== Infinity) {
              return { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom, width: maxRight - minLeft, height: maxBottom - minTop };
            }
          }

          // Second try: use getClientRects() on the equation element itself
          const rects = equationEl.getClientRects();
          if (rects.length > 0) {
            for (const rect of rects) {
              if (rect.width > 0 && rect.height > 0) {
                minLeft = Math.min(minLeft, rect.left);
                minTop = Math.min(minTop, rect.top);
                maxRight = Math.max(maxRight, rect.right);
                maxBottom = Math.max(maxBottom, rect.bottom);
              }
            }
            if (minLeft !== Infinity) {
              return { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom, width: maxRight - minLeft, height: maxBottom - minTop };
            }
          }

          // Third try: find all text-containing leaf spans
          const spans = equationEl.querySelectorAll('span');
          spans.forEach(span => {
            // Only consider spans that directly contain text (leaf nodes)
            if (span.children.length === 0 && span.textContent.trim()) {
              const rect = span.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && rect.width < 500) { // Skip full-width containers
                minLeft = Math.min(minLeft, rect.left);
                minTop = Math.min(minTop, rect.top);
                maxRight = Math.max(maxRight, rect.right);
                maxBottom = Math.max(maxBottom, rect.bottom);
              }
            }
          });
          if (minLeft !== Infinity) {
            return { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom, width: maxRight - minLeft, height: maxBottom - minTop };
          }

          // Last resort: use the container rect
          return equationEl.getBoundingClientRect();
        };

        const charRects = [];
        const processedEquations = new Set(); // Track equations we've already fully included

        const walker = document.createTreeWalker(
          range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentNode
            : range.commonAncestorContainer,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );

        let node;
        while (node = walker.nextNode()) {
          if (!range.intersectsNode(node)) continue;

          // Check if this node is inside an equation
          const equationEl = getEquationAncestor(node);

          if (equationEl) {
            // This is part of an equation - include the WHOLE equation (but only once)
            if (processedEquations.has(equationEl)) continue;
            processedEquations.add(equationEl);

            // Get the tight bounding rect of the equation content (not full line width)
            const eqRect = getEquationContentRect(equationEl);
            const eqWidth = eqRect.right - eqRect.left;
            const eqHeight = eqRect.bottom - eqRect.top;
            if (eqWidth > 0 && eqHeight > 0) {
              charRects.push({
                left: eqRect.left,
                right: eqRect.right,
                top: eqRect.top,
                bottom: eqRect.bottom
              });
              console.log(`JAL: Expanded to full equation: ${equationEl.textContent?.slice(0, 30)}...`);
            }
          } else {
            // Regular text - process character by character
            const text = node.textContent;
            if (!text || text.length === 0) continue;

            for (let i = 0; i < text.length; i++) {
              try {
                if (range.comparePoint(node, i) < 0) continue;
                if (range.comparePoint(node, i) > 0) break;
              } catch (e) {
                continue;
              }

              const charRange = document.createRange();
              charRange.setStart(node, i);
              charRange.setEnd(node, Math.min(i + 1, text.length));

              const rects = charRange.getClientRects();
              for (const rect of rects) {
                if (rect.width > 0 && rect.height > 0) {
                  charRects.push({
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom
                  });
                }
              }
            }
          }
        }

        // Fallback to getClientRects if no character rects found
        let lines = charRects;
        if (lines.length === 0) {
          const rects = range.getClientRects();
          lines = [...rects]
            .filter(r => r.width > 0 && r.height > 0)
            .map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        }

        if (lines.length === 0) return highlights;

        // NO MERGING - create highlight for each raw rect
        // Use alternating colors to distinguish segments
        const colors = [
          'rgba(255, 100, 100, 0.5)',  // red
          'rgba(100, 255, 100, 0.5)',  // green
          'rgba(100, 100, 255, 0.5)',  // blue
          'rgba(255, 255, 100, 0.5)',  // yellow
          'rgba(255, 100, 255, 0.5)',  // magenta
          'rgba(100, 255, 255, 0.5)',  // cyan
        ];

        lines.forEach((line, index) => {
          const lineHeight = line.bottom - line.top;
          const lineWidth = line.right - line.left;
          const relativeTop = line.top - messageRect.top;
          const relativeLeft = line.left - messageRect.left;
          const color = colors[index % colors.length];

          const highlight = document.createElement('div');
          highlight.className = 'jal-highlight-overlay';
          highlight.dataset.commentId = commentId;
          highlight.style.cssText = `
            position: absolute;
            left: ${relativeLeft}px;
            top: ${relativeTop}px;
            width: ${lineWidth}px;
            height: ${lineHeight}px;
            background-color: ${color};
            pointer-events: none;
            z-index: -1;
            border: 1px solid rgba(0,0,0,0.3);
          `;

          messageElement.appendChild(highlight);
          highlights.push(highlight);
        });

      } catch (e) {
        console.error('JAL highlightRangeUnmerged error:', e);
      }

      return highlights;
    },

    /**
     * Setup resize and scroll handlers for repositioning comments
     * NOTE: Scroll handler disabled to prevent performance issues during streaming
     */
    setupPositionHandlers() {
      if (this._positionHandlersSetup) return;
      this._positionHandlersSetup = true;

      // Debounced reposition for resize only
      let resizeTimeout;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => this.positionComments(), 150);
      });

      // DISABLED: Scroll handler causes performance issues during ChatGPT streaming
      // The scroll handler was calling positionComments() which forces layout recalculation
      // via getBoundingClientRect() on every highlight element, blocking the main thread.
      //
      // TODO: Re-enable with streaming detection if comment repositioning during scroll is needed
      // let lastScrollTime = 0;
      // const handleScroll = () => {
      //   const now = Date.now();
      //   if (now - lastScrollTime < 100) return;
      //   lastScrollTime = now;
      //   requestAnimationFrame(() => this.positionComments());
      // };
      // const scrollContainer = this.findScrollContainer();
      // if (scrollContainer) {
      //   scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
      // }

      console.log('JAL: Position handlers setup (scroll handler disabled for performance)');
    },

    /**
     * Get element nodes within a range (for equations, images, etc.)
     */
    getElementsInRange(range) {
      const elements = [];
      const container = range.commonAncestorContainer;

      // If container is an element, check if it's fully selected
      if (container.nodeType === Node.ELEMENT_NODE) {
        // Get all child elements
        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_ELEMENT,
          null,
          false
        );

        let node;
        while ((node = walker.nextNode())) {
          // Check if this element is within the selection
          if (range.intersectsNode(node)) {
            // Prefer leaf elements (no child elements with content)
            const hasChildElements = node.querySelector('*');
            if (!hasChildElements || node.matches('.katex, .MathJax, mjx-container, svg, img, code')) {
              elements.push(node);
            }
          }
        }

        // If no child elements found, use the container itself
        if (elements.length === 0 && container !== document.body) {
          elements.push(container);
        }
      } else if (container.parentElement) {
        // If container is a text node, use its parent
        elements.push(container.parentElement);
      }

      return elements;
    },

    /**
     * Find equation elements that are ACTUALLY SELECTED (intersected by range)
     * Only returns top-level equation elements that the range passes through
     */
    findEquationElementsInRange(range) {
      // Only look for top-level equation containers
      const topLevelSelectors = '.katex, .MathJax, .MathJax_Display, mjx-container';
      const elements = [];

      // Check if selection actually contains equation elements
      const container = range.commonAncestorContainer;
      let searchContext = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;

      // Check if the range's common ancestor IS an equation
      const ancestorEquation = searchContext?.closest(topLevelSelectors);
      if (ancestorEquation && !ancestorEquation.classList.contains('jal-highlight-element')) {
        elements.push(ancestorEquation);
        return elements;
      }

      // Find equations within the range that are actually selected
      if (searchContext) {
        const equations = searchContext.querySelectorAll(topLevelSelectors);
        for (const eq of equations) {
          // Must actually intersect with the range (not just nearby)
          if (!range.intersectsNode(eq)) continue;
          // Skip if already highlighted
          if (eq.classList.contains('jal-highlight-element')) continue;
          // Only top-level equations
          if (eq.closest(topLevelSelectors) !== eq) continue;

          elements.push(eq);
        }
      }

      return elements;
    },

    /**
     * Get all text nodes within a range with their start/end offsets
     */
    getTextNodesInRange(range) {
      const textNodes = [];
      const startContainer = range.startContainer;
      const endContainer = range.endContainer;
      const startOffset = range.startOffset;
      const endOffset = range.endOffset;

      // If start and end are the same text node
      if (startContainer === endContainer && startContainer.nodeType === Node.TEXT_NODE) {
        textNodes.push({ node: startContainer, start: startOffset, end: endOffset });
        return textNodes;
      }

      // Walk through all text nodes in the range
      const walker = document.createTreeWalker(
        range.commonAncestorContainer,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let node;
      let inRange = false;

      while ((node = walker.nextNode())) {
        if (node === startContainer) {
          inRange = true;
          textNodes.push({
            node,
            start: startOffset,
            end: node.textContent.length
          });
        } else if (node === endContainer) {
          textNodes.push({
            node,
            start: 0,
            end: endOffset
          });
          break;
        } else if (inRange) {
          textNodes.push({
            node,
            start: 0,
            end: node.textContent.length
          });
        }
      }

      return textNodes;
    },

    /**
     * Escape HTML for safe rendering
     */
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => JAL.init());
  } else {
    // Wait a bit for SPAs to settle, then init
    setTimeout(() => JAL.init(), 500);
  }

})();

console.log('JAL Content Script loaded');
