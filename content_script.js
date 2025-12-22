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

    // Load existing comments
    await JAL.loadComments();

    // Mark existing messages
    JAL.markAllMessages();

    // Setup event listeners
    JAL.setupEventListeners();

    // Start observing for new messages
    JAL.startObserving();

    console.log('JAL: Initialized successfully');
  };

  /**
   * Load comments from storage
   */
  JAL.loadComments = async function() {
    const comments = await JAL.Storage.getComments(JAL.state.pageId);
    JAL.state.comments = comments;
    JAL.UI.renderComments();
    JAL.UI.renderHighlights();
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

    // Handle navigation/URL changes
    let lastUrl = window.location.href;
    new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        JAL.handleUrlChange();
      }
    }).observe(document.body, { childList: true, subtree: true });
  };

  /**
   * Handle URL changes (navigation within SPA)
   */
  JAL.handleUrlChange = async function() {
    JAL.state.pageId = JAL.Utils.getPageId(window.location.href);
    await JAL.loadComments();
    JAL.markAllMessages();
  };

  /**
   * Handle text selection
   */
  JAL.handleSelection = function(e) {
    const selection = window.getSelection();

    // Hide floating button if selection is empty
    if (!selection || selection.isCollapsed || selection.toString().trim().length === 0) {
      JAL.UI.hideFloatingButton();
      return;
    }

    console.log('JAL: Selection detected:', selection.toString().slice(0, 50));

    // Check if selection is within an assistant message
    const range = selection.getRangeAt(0);
    const container = JAL.state.adapter.findMessageContainer(range.commonAncestorContainer);

    console.log('JAL: Found container:', container);

    if (!container) {
      console.log('JAL: No container found for selection');
      JAL.UI.hideFloatingButton();
      return;
    }

    // Make sure it's an assistant message
    const isAssistant = JAL.state.adapter.isAssistantMessage(container);
    console.log('JAL: Is assistant message:', isAssistant);

    if (!isAssistant) {
      JAL.UI.hideFloatingButton();
      return;
    }

    // Show floating button near selection
    const rect = range.getBoundingClientRect();
    console.log('JAL: Showing button at', rect.right + 10, rect.top);
    JAL.UI.showFloatingButton(rect.right + 10, rect.top);
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
   */
  JAL.startObserving = function() {
    if (JAL.state.isObserving) return;

    JAL.state.adapter.observeNewMessages((newMessage) => {
      // Mark the new message
      const fp = JAL.state.adapter.markMessage(newMessage);

      // If we have a pending jump, this might be the response
      if (JAL.state.pendingJump) {
        JAL.state.pendingJump.toBlockFp = fp;
        JAL.state.pendingJump.toScrollY = JAL.state.adapter.getScrollPosition();

        // Jump to the new message
        setTimeout(() => {
          JAL.Utils.scrollToElement(newMessage, 100);
          JAL.Utils.flashHighlight(newMessage);
        }, 500);

        JAL.state.pendingJump = null;
      }

      // Re-render highlights in case any comments reference this message
      JAL.UI.renderHighlights();
    });

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
      console.log('JAL DEBUG: createOverlay called');
      // Main container
      const container = document.createElement('div');
      container.id = 'jal-container';
      console.log('JAL DEBUG: creating container element');
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
        <button id="jal-floating-btn" class="jal-floating-btn jal-hidden">+ Comment</button>
        <div id="jal-comment-input" class="jal-comment-input jal-hidden">
          <textarea id="jal-comment-textarea" placeholder="Enter your comment (or just '?')"></textarea>
          <div class="jal-input-actions">
            <button class="jal-btn jal-btn-primary" id="jal-save-comment">Save</button>
            <button class="jal-btn" id="jal-cancel-comment">Cancel</button>
          </div>
        </div>
      `;

      document.body.appendChild(container);
      JAL.state.ui.container = container;
      console.log('JAL DEBUG: container appended to body');
      console.log('JAL DEBUG: container element:', document.getElementById('jal-container'));
      console.log('JAL DEBUG: panel element:', document.getElementById('jal-panel'));
      console.log('JAL DEBUG: comments list element:', document.getElementById('jal-comments-list'));

      // Event listeners for UI
      document.getElementById('jal-toggle-btn').addEventListener('click', () => this.togglePanel());
      document.getElementById('jal-close-btn').addEventListener('click', () => this.togglePanel());
      document.getElementById('jal-send-btn').addEventListener('click', () => JAL.sendSelected());
      document.getElementById('jal-return-btn').addEventListener('click', () => JAL.jumpReturn());
      document.getElementById('jal-floating-btn').addEventListener('click', () => JAL.addCommentFromSelection());
      document.getElementById('jal-save-comment').addEventListener('click', () => this.saveCommentFromInput());
      document.getElementById('jal-cancel-comment').addEventListener('click', () => this.hideCommentInput());
      console.log('JAL DEBUG: event listeners attached');

      // Debug: Check computed styles
      this.debugStyles();
    },

    /**
     * Debug helper to check computed styles of key elements
     */
    debugStyles() {
      console.log('JAL DEBUG: ========= STYLE DEBUG =========');
      const container = document.getElementById('jal-container');
      const panel = document.getElementById('jal-panel');
      const header = document.querySelector('.jal-panel-header');
      const list = document.getElementById('jal-comments-list');
      const toggleBtn = document.getElementById('jal-toggle-btn');

      if (container) {
        const cs = window.getComputedStyle(container);
        console.log('JAL DEBUG: container styles:', {
          position: cs.position,
          zIndex: cs.zIndex,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          pointerEvents: cs.pointerEvents
        });
      }

      if (panel) {
        const cs = window.getComputedStyle(panel);
        console.log('JAL DEBUG: panel styles:', {
          position: cs.position,
          top: cs.top,
          right: cs.right,
          width: cs.width,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          zIndex: cs.zIndex,
          pointerEvents: cs.pointerEvents
        });
      }

      if (header) {
        const cs = window.getComputedStyle(header);
        console.log('JAL DEBUG: header styles:', {
          position: cs.position,
          top: cs.top,
          right: cs.right,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          zIndex: cs.zIndex,
          pointerEvents: cs.pointerEvents,
          background: cs.background
        });
      }

      if (toggleBtn) {
        const cs = window.getComputedStyle(toggleBtn);
        console.log('JAL DEBUG: toggle button styles:', {
          position: cs.position,
          top: cs.top,
          right: cs.right,
          width: cs.width,
          height: cs.height,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          zIndex: cs.zIndex
        });
      }

      console.log('JAL DEBUG: ========= END STYLE DEBUG =========');
    },

    /**
     * Toggle the panel visibility
     */
    togglePanel() {
      console.log('JAL DEBUG: togglePanel called');
      const panel = document.getElementById('jal-panel');
      console.log('JAL DEBUG: panel before toggle:', panel, 'has jal-hidden:', panel.classList.contains('jal-hidden'));
      panel.classList.toggle('jal-hidden');
      console.log('JAL DEBUG: panel after toggle, has jal-hidden:', panel.classList.contains('jal-hidden'));

      // Re-check styles after toggle
      setTimeout(() => {
        this.debugStyles();
        // Also reposition comments when panel becomes visible
        if (!panel.classList.contains('jal-hidden')) {
          console.log('JAL DEBUG: panel now visible, repositioning comments');
          this.positionComments();
        }
      }, 100);
    },

    /**
     * Show the floating "+ Comment" button
     */
    showFloatingButton(x, y) {
      const btn = document.getElementById('jal-floating-btn');
      btn.style.left = `${x}px`;
      btn.style.top = `${y + window.scrollY}px`;
      btn.classList.remove('jal-hidden');
    },

    /**
     * Hide the floating button
     */
    hideFloatingButton() {
      const btn = document.getElementById('jal-floating-btn');
      btn.classList.add('jal-hidden');
    },

    /**
     * Show comment input near anchor
     */
    showCommentInput(anchor, messageElement) {
      this.pendingAnchor = anchor;
      this.pendingMessage = messageElement;

      const input = document.getElementById('jal-comment-input');
      const textarea = document.getElementById('jal-comment-textarea');

      // Position near the selection
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        input.style.left = `${rect.right + 20}px`;
        input.style.top = `${rect.top + window.scrollY}px`;
      }

      input.classList.remove('jal-hidden');
      textarea.value = '';
      textarea.focus();

      this.hideFloatingButton();
    },

    /**
     * Hide comment input
     */
    hideCommentInput() {
      const input = document.getElementById('jal-comment-input');
      input.classList.add('jal-hidden');
      this.pendingAnchor = null;
      this.pendingMessage = null;
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
        await JAL.saveComment(this.pendingAnchor, body);
      }

      this.hideCommentInput();
    },

    /**
     * Render comments in the margin, aligned with their highlights
     */
    renderComments() {
      console.log('JAL DEBUG: renderComments called');
      const list = document.getElementById('jal-comments-list');
      console.log('JAL DEBUG: comments list element:', list);
      const comments = JAL.state.comments;
      console.log('JAL DEBUG: comments to render:', comments.length, comments);

      if (comments.length === 0) {
        console.log('JAL DEBUG: No comments, showing empty state');
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
      console.log('JAL DEBUG: positionComments called');
      const list = document.getElementById('jal-comments-list');
      console.log('JAL DEBUG: list element:', list);
      const cards = list.querySelectorAll('.jal-comment-card');
      console.log('JAL DEBUG: found cards:', cards.length);

      // Collect positions for all comments
      const positions = [];

      cards.forEach(card => {
        const commentId = card.dataset.commentId;
        console.log('JAL DEBUG: processing card for commentId:', commentId);
        const highlights = JAL.state.ui.highlights.get(commentId);
        console.log('JAL DEBUG: highlights for this comment:', highlights);

        if (highlights && highlights.length > 0) {
          // Get the position of the first highlight element
          const firstHighlight = highlights[0];
          console.log('JAL DEBUG: first highlight element:', firstHighlight);
          const rect = firstHighlight.getBoundingClientRect();
          console.log('JAL DEBUG: highlight rect:', rect);
          const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
          console.log('JAL DEBUG: scrollTop:', scrollTop);

          const targetTop = rect.top + scrollTop;
          console.log('JAL DEBUG: calculated targetTop:', targetTop);

          positions.push({
            card,
            commentId,
            targetTop: targetTop, // Absolute position on page
            height: 0 // Will be calculated after initial positioning
          });
        } else {
          // No highlight found - hide the card or position at end
          console.log('JAL DEBUG: no highlights found for card, hiding');
          card.style.display = 'none';
        }
      });

      console.log('JAL DEBUG: positions collected:', positions.length, positions);

      // Sort by target position (top to bottom)
      positions.sort((a, b) => a.targetTop - b.targetTop);

      // Position cards with overlap handling
      let lastBottom = 0;
      const minGap = 8; // Minimum gap between cards

      positions.forEach(pos => {
        pos.card.style.display = ''; // Ensure visible

        // Calculate actual top position, avoiding overlaps
        let actualTop = pos.targetTop;
        if (actualTop < lastBottom + minGap) {
          actualTop = lastBottom + minGap;
        }

        console.log('JAL DEBUG: positioning card at top:', actualTop);
        pos.card.style.top = `${actualTop}px`;

        // Update lastBottom for next card
        const cardHeight = pos.card.offsetHeight;
        console.log('JAL DEBUG: card height:', cardHeight);
        lastBottom = actualTop + cardHeight;
      });

      console.log('JAL DEBUG: positionComments complete');

      // Final debug: check actual rendered positions
      cards.forEach(card => {
        const rect = card.getBoundingClientRect();
        const cs = window.getComputedStyle(card);
        console.log('JAL DEBUG: card final state:', {
          commentId: card.dataset.commentId,
          boundingRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          computedTop: cs.top,
          computedDisplay: cs.display,
          computedVisibility: cs.visibility,
          computedOpacity: cs.opacity
        });
      });
    },

    /**
     * Render highlights for all comments
     */
    renderHighlights() {
      console.log('JAL DEBUG: ========= renderHighlights START =========');
      console.log('JAL DEBUG: renderHighlights called, comments:', JAL.state.comments.length);
      console.log('JAL DEBUG: comments array:', JAL.state.comments);

      // Clear existing mark highlights
      document.querySelectorAll('mark.jal-highlight').forEach(el => {
        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          parent.removeChild(el);
          // Normalize to merge adjacent text nodes
          parent.normalize();
        }
      });

      // Clear element highlights (for equations, etc.)
      document.querySelectorAll('.jal-highlight-element').forEach(el => {
        el.classList.remove('jal-highlight-element');
        delete el.dataset.jalCommentId;
        el.style.removeProperty('background');
        el.style.removeProperty('outline');
        el.style.removeProperty('outline-offset');
        el.style.removeProperty('border-radius');
      });

      JAL.state.ui.highlights.clear();

      const messages = JAL.state.adapter.getAssistantMessages();
      console.log('JAL: Found messages:', messages.length);

      for (const comment of JAL.state.comments) {
        console.log('JAL: Processing comment:', comment.commentId, 'fingerprint:', comment.anchor.messageFingerprint);

        // Find the message this comment belongs to
        const targetMessage = messages.find(m =>
          m.getAttribute('data-jal-message') === comment.anchor.messageFingerprint
        );

        if (!targetMessage) {
          console.log('JAL: No target message found for comment');
          continue;
        }
        console.log('JAL: Found target message');

        // Create range for the anchor
        const range = JAL.Anchoring.createRangeForAnchor(comment.anchor, targetMessage);

        if (!range) {
          console.log('JAL: Could not create range for anchor');
          continue;
        }
        console.log('JAL: Created range:', range);

        // Highlight the range
        const highlights = this.highlightRange(range, comment.commentId);
        JAL.state.ui.highlights.set(comment.commentId, highlights);
      }

      // Position comments in margin after highlights are rendered
      // Use requestAnimationFrame to ensure DOM has updated
      console.log('JAL DEBUG: scheduling positionComments via requestAnimationFrame');
      requestAnimationFrame(() => {
        console.log('JAL DEBUG: requestAnimationFrame callback executing');
        this.positionComments();
        this.setupPositionHandlers();
      });
    },

    /**
     * Highlight a range by wrapping text nodes in mark elements
     * Falls back to adding highlight class to elements for non-text content (equations, etc.)
     */
    highlightRange(range, commentId) {
      const highlights = [];

      try {
        // First, check if the range contains or is near equation elements
        // If so, prefer highlighting those directly instead of text nodes
        const equationElements = this.findEquationElementsNearRange(range);
        if (equationElements.length > 0) {
          console.log('JAL: Found equation elements in range:', equationElements);
          for (const el of equationElements) {
            this.highlightEquationElement(el, commentId);
            highlights.push(el);
          }
          return highlights;
        }

        // Get all text nodes within the range
        const textNodes = this.getTextNodesInRange(range);

        if (textNodes.length > 0) {
          // Wrap text nodes
          for (const { node, start, end } of textNodes) {
            const nodeRange = document.createRange();
            nodeRange.setStart(node, start);
            nodeRange.setEnd(node, end);

            const mark = document.createElement('mark');
            mark.className = 'jal-highlight';
            mark.dataset.commentId = commentId;
            // Force inline styles to override any site CSS
            mark.style.setProperty('background', 'rgba(255, 220, 100, 0.5)', 'important');
            mark.style.setProperty('background-color', 'rgba(255, 220, 100, 0.5)', 'important');
            mark.style.setProperty('border-bottom', '2px solid #f6ad55', 'important');
            mark.style.setProperty('padding', '0', 'important');
            mark.style.setProperty('margin', '0', 'important');
            mark.style.setProperty('display', 'inline', 'important');
            mark.style.setProperty('color', 'inherit', 'important');

            try {
              nodeRange.surroundContents(mark);
              console.log('JAL: Wrapped text node:', mark, 'parent:', mark.parentElement);
              highlights.push(mark);

              // Add hover/click interaction to highlight corresponding comment
              mark.addEventListener('mouseenter', () => {
                const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
                if (card) card.classList.add('jal-active');
              });
              mark.addEventListener('mouseleave', () => {
                const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
                if (card) card.classList.remove('jal-active');
              });
              mark.addEventListener('click', () => {
                const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
                if (card) {
                  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  card.classList.add('jal-flash');
                  setTimeout(() => card.classList.remove('jal-flash'), 2000);
                }
              });
            } catch (e) {
              console.warn('JAL: Could not wrap text node', e);
            }
          }
        }

        // If no text nodes found or wrapped, highlight element nodes directly
        if (highlights.length === 0) {
          const elements = this.getElementsInRange(range);
          console.log('JAL: No text nodes, highlighting elements:', elements);
          for (const el of elements) {
            el.classList.add('jal-highlight-element');
            el.dataset.jalCommentId = commentId;
            // Force inline styles for equation elements that might override CSS
            el.style.setProperty('background', 'rgba(255, 220, 100, 0.4)', 'important');
            el.style.setProperty('outline', '2px solid #f6ad55', 'important');
            el.style.setProperty('outline-offset', '2px', 'important');
            el.style.setProperty('border-radius', '4px', 'important');
            highlights.push(el);

            // Add hover/click interaction to highlight corresponding comment
            el.addEventListener('mouseenter', () => {
              const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
              if (card) card.classList.add('jal-active');
            });
            el.addEventListener('mouseleave', () => {
              const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
              if (card) card.classList.remove('jal-active');
            });
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
              if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('jal-flash');
                setTimeout(() => card.classList.remove('jal-flash'), 2000);
              }
            });
          }
        }

        console.log('JAL: Created highlights:', highlights.length);
      } catch (e) {
        console.warn('JAL: Could not highlight range', e);
      }

      return highlights;
    },

    /**
     * Setup resize and scroll handlers for repositioning comments
     */
    setupPositionHandlers() {
      if (this._positionHandlersSetup) return;
      this._positionHandlersSetup = true;

      // Debounced reposition function
      let repositionTimeout;
      const debouncedReposition = () => {
        clearTimeout(repositionTimeout);
        repositionTimeout = setTimeout(() => {
          this.positionComments();
        }, 100);
      };

      // Reposition on window resize
      window.addEventListener('resize', debouncedReposition);

      // Also observe mutations in the main content area
      // (for when messages load/change)
      const mainContent = document.body;
      const observer = new MutationObserver(debouncedReposition);
      observer.observe(mainContent, {
        childList: true,
        subtree: true,
        characterData: true
      });
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
     * Find equation elements (KaTeX, MathJax, etc.) near a range
     */
    findEquationElementsNearRange(range) {
      const equationSelectors = [
        '.katex',
        '.MathJax',
        '.MathJax_Display',
        'mjx-container',
        '.math-inline',
        '.math-display',
        '[class*="math"]',
        '[class*="equation"]',
        'annotation[encoding*="tex"]'
      ].join(', ');

      const elements = [];
      const container = range.commonAncestorContainer;

      // Get the search context - either the element container or its parent
      let searchContext;
      if (container.nodeType === Node.TEXT_NODE) {
        searchContext = container.parentElement;
      } else {
        searchContext = container;
      }

      // Also check ancestors up to 3 levels for equations
      let checkElement = searchContext;
      for (let i = 0; i < 4 && checkElement && checkElement !== document.body; i++) {
        // Check if this element itself is an equation
        if (checkElement.matches && checkElement.matches(equationSelectors)) {
          elements.push(checkElement);
          return elements; // Found equation ancestor, return it
        }

        // Check for equation children within this element
        const equationChildren = checkElement.querySelectorAll(equationSelectors);
        if (equationChildren.length > 0) {
          // Check if any of these intersect with our range
          for (const eq of equationChildren) {
            if (range.intersectsNode(eq) || this.isNodeNearRange(eq, range, 50)) {
              elements.push(eq);
            }
          }
          if (elements.length > 0) {
            return elements;
          }
        }

        checkElement = checkElement.parentElement;
      }

      return elements;
    },

    /**
     * Check if a node is near a range (within pixel distance)
     */
    isNodeNearRange(node, range, maxDistance) {
      try {
        const nodeRect = node.getBoundingClientRect();
        const rangeRect = range.getBoundingClientRect();

        // Check if they're close enough
        const horizontalDist = Math.min(
          Math.abs(nodeRect.left - rangeRect.right),
          Math.abs(rangeRect.left - nodeRect.right)
        );
        const verticalDist = Math.min(
          Math.abs(nodeRect.top - rangeRect.bottom),
          Math.abs(rangeRect.top - nodeRect.bottom)
        );

        // If ranges overlap, distance is 0
        const overlap = !(nodeRect.right < rangeRect.left ||
                         nodeRect.left > rangeRect.right ||
                         nodeRect.bottom < rangeRect.top ||
                         nodeRect.top > rangeRect.bottom);

        return overlap || (horizontalDist < maxDistance && verticalDist < maxDistance);
      } catch (e) {
        return false;
      }
    },

    /**
     * Highlight an equation element with styles and event listeners
     */
    highlightEquationElement(el, commentId) {
      el.classList.add('jal-highlight-element');
      el.dataset.jalCommentId = commentId;

      // Force inline styles for equation elements that might override CSS
      el.style.setProperty('background', 'rgba(255, 220, 100, 0.4)', 'important');
      el.style.setProperty('outline', '2px solid #f6ad55', 'important');
      el.style.setProperty('outline-offset', '2px', 'important');
      el.style.setProperty('border-radius', '4px', 'important');

      // Add hover/click interaction
      el.addEventListener('mouseenter', () => {
        const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
        if (card) card.classList.add('jal-active');
      });
      el.addEventListener('mouseleave', () => {
        const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
        if (card) card.classList.remove('jal-active');
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = document.querySelector(`.jal-comment-card[data-comment-id="${commentId}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('jal-flash');
          setTimeout(() => card.classList.remove('jal-flash'), 2000);
        }
      });
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
    // Wait a bit for SPAs to settle
    setTimeout(() => JAL.init(), 1000);
  }

})();

console.log('JAL Content Script loaded');
