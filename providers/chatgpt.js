/**
 * JAL - ChatGPT Provider Adapter
 * Works with chatgpt.com and chat.openai.com
 */

window.JAL = window.JAL || {};
window.JAL.Providers = window.JAL.Providers || {};

window.JAL.Providers.chatgpt = {
  name: 'chatgpt',

  // Selectors - these may need updating if ChatGPT changes their DOM
  // We use multiple fallback strategies
  selectors: {
    // Message containers - try multiple patterns
    messageContainer: [
      '[data-message-author-role="assistant"]',
      'div[data-message-id]',
      '.agent-turn',
      '[class*="agent"]'
    ],
    // The main conversation area
    conversationArea: [
      'main',
      '[role="main"]',
      '.flex-1.overflow-hidden'
    ],
    // Chat input
    composer: [
      '#prompt-textarea',
      'textarea[data-id="root"]',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'textarea',
      '[contenteditable="true"]'
    ],
    // Scroll container
    scrollContainer: [
      'main .overflow-y-auto',
      'main',
      '[class*="overflow"]'
    ]
  },

  /**
   * Check if this provider is active
   */
  isActive() {
    const hostname = window.location.hostname;
    return hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com');
  },

  /**
   * Find element using multiple selector fallbacks
   */
  _findElement(selectorList) {
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  },

  /**
   * Find all elements using multiple selector fallbacks
   */
  _findElements(selectorList) {
    for (const selector of selectorList) {
      const els = document.querySelectorAll(selector);
      if (els.length > 0) return [...els];
    }
    return [];
  },

  /**
   * Get all user message elements
   */
  getUserMessages() {
    let messages = document.querySelectorAll('[data-message-author-role="user"]');
    if (messages.length > 0) {
      return [...messages];
    }
    return [];
  },

  /**
   * Get text content of all user messages combined
   */
  getAllUserMessageText() {
    const messages = this.getUserMessages();
    return messages.map(m => m.textContent || '').join('\n');
  },

  /**
   * Get all assistant message elements
   */
  getAssistantMessages() {
    // Primary: look for data attributes
    let messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (messages.length > 0) {
      return [...messages];
    }

    // Fallback: look for alternating message pattern
    // ChatGPT typically alternates user/assistant
    const allMessages = document.querySelectorAll('[data-message-id]');
    if (allMessages.length > 0) {
      // Filter to assistant messages (typically have markdown content, longer text)
      return [...allMessages].filter((el, idx) => {
        // Even indices are often user, odd are assistant
        // But also check for markdown content as a signal
        const hasMarkdown = el.querySelector('.markdown, .prose, pre, code');
        return hasMarkdown || idx % 2 === 1;
      });
    }

    // Last resort: find large text blocks that look like AI responses
    return this._findMessagesByHeuristics();
  },

  /**
   * Heuristic message detection when selectors fail
   */
  _findMessagesByHeuristics() {
    const candidates = document.querySelectorAll('div');
    const messages = [];

    for (const div of candidates) {
      // Skip if too small
      const rect = div.getBoundingClientRect();
      if (rect.width < 300 || rect.height < 50) continue;

      // Check for AI response signals
      const text = div.textContent || '';
      if (text.length < 100) continue;

      // Look for markdown-like content
      const hasCode = div.querySelector('pre, code');
      const hasParagraphs = div.querySelectorAll('p').length > 0;

      if (hasCode || hasParagraphs) {
        // Make sure it's not a container of containers
        const parentHasMultiple = div.parentElement?.querySelectorAll('div').length > 5;
        if (!parentHasMultiple || div.closest('[data-message-id]')) {
          messages.push(div);
        }
      }
    }

    // Deduplicate by removing nested elements
    return messages.filter(el => !messages.some(other => other !== el && other.contains(el)));
  },

  /**
   * Find the message container from a node
   */
  findMessageContainer(node) {
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

    while (current && current !== document.body) {
      // Check for data attribute
      if (current.hasAttribute('data-message-author-role') ||
          current.hasAttribute('data-message-id')) {
        // Go up one more to get the full container
        const parent = current.parentElement;
        if (parent?.hasAttribute('data-message-id')) {
          return parent;
        }
        return current;
      }

      // Check for JAL marker
      if (current.hasAttribute('data-jal-message')) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  },

  /**
   * Check if element is an assistant message
   */
  isAssistantMessage(element) {
    // Direct attribute check
    if (element.getAttribute('data-message-author-role') === 'assistant') {
      return true;
    }

    // Check ancestors
    const ancestor = element.closest('[data-message-author-role]');
    if (ancestor?.getAttribute('data-message-author-role') === 'assistant') {
      return true;
    }

    // Heuristic: has markdown content and substantial text
    if (element.querySelector('.markdown, .prose') && element.textContent.length > 100) {
      return true;
    }

    return false;
  },

  /**
   * Get message text content
   */
  getMessageText(element) {
    // Try to find the markdown container first
    const markdown = element.querySelector('.markdown, .prose');
    if (markdown) {
      return window.JAL.Utils.getTextContent(markdown);
    }
    return window.JAL.Utils.getTextContent(element);
  },

  /**
   * Get the composer element
   */
  getComposerElement() {
    return this._findElement(this.selectors.composer);
  },

  /**
   * Get current text content from the composer
   */
  getComposerContent() {
    const composer = this.getComposerElement();
    if (!composer) return '';

    if (composer.isContentEditable || composer.getAttribute('contenteditable') === 'true') {
      return composer.textContent || '';
    }

    if (composer.tagName === 'TEXTAREA') {
      return composer.value || '';
    }

    return '';
  },

  /**
   * Insert text into ChatGPT's composer
   */
  insertIntoComposer(text) {
    const composer = this.getComposerElement();
    if (!composer) {
      console.warn('JAL: Could not find ChatGPT composer');
      return false;
    }

    composer.focus();

    // ChatGPT uses a contenteditable div now
    if (composer.isContentEditable || composer.getAttribute('contenteditable') === 'true') {
      // Clear existing content
      composer.innerHTML = '';

      // Create a paragraph with the text
      const p = document.createElement('p');
      p.textContent = text;
      composer.appendChild(p);

      // Dispatch React-compatible events
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));

      // Move cursor to end
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return true;
    }

    // Fallback for textarea
    if (composer.tagName === 'TEXTAREA') {
      composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));

      // Trigger React's onChange
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      ).set;
      nativeInputValueSetter.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));

      return true;
    }

    return false;
  },

  /**
   * Append text to the composer (keeps existing content)
   */
  appendToComposer(text) {
    const composer = this.getComposerElement();
    if (!composer) {
      console.warn('JAL: Could not find ChatGPT composer');
      return false;
    }

    composer.focus();
    const existingContent = this.getComposerContent();
    const newContent = existingContent ? existingContent + '\n\n' + text : text;

    // ChatGPT uses a contenteditable div now
    if (composer.isContentEditable || composer.getAttribute('contenteditable') === 'true') {
      composer.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = newContent;
      composer.appendChild(p);

      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));

      // Move cursor to end
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return true;
    }

    // Fallback for textarea
    if (composer.tagName === 'TEXTAREA') {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      ).set;
      nativeInputValueSetter.call(composer, newContent);
      composer.dispatchEvent(new Event('input', { bubbles: true }));

      return true;
    }

    return false;
  },

  /**
   * Get the messages container for observation
   */
  getMessagesContainer() {
    // Look for the main conversation scroll container
    const main = document.querySelector('main');
    if (main) {
      // Find the scrollable area within main
      const scrollable = main.querySelector('.overflow-y-auto') ||
                         main.querySelector('[class*="overflow"]') ||
                         main;
      return scrollable;
    }
    return document.body;
  },

  /**
   * Get current scroll position in the messages area
   */
  getScrollPosition() {
    const container = this.getMessagesContainer();
    return container?.scrollTop || window.scrollY;
  },

  /**
   * Scroll to a position
   */
  scrollToPosition(position) {
    const container = this.getMessagesContainer();
    if (container && container !== document.body) {
      container.scrollTo({ top: position, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: position, behavior: 'smooth' });
    }
  },

  /**
   * Mark a message element for JAL tracking
   */
  markMessage(element) {
    if (!element.hasAttribute('data-jal-message')) {
      const fp = window.JAL.Utils.fingerprint(this.getMessageText(element));
      element.setAttribute('data-jal-message', fp);
      element.setAttribute('data-jal-provider', this.name);
    }
    return element.getAttribute('data-jal-message');
  },

  /**
   * Start observing for new assistant messages
   */
  observeNewMessages(callback) {
    const container = this.getMessagesContainer();
    if (!container) {
      console.warn('JAL: Could not find messages container');
      return null;
    }

    const self = this;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if this is a new assistant message
            const messages = self.isAssistantMessage(node)
              ? [node]
              : node.querySelectorAll ? [...node.querySelectorAll('[data-message-author-role="assistant"]')] : [];

            for (const msg of messages) {
              callback(msg);
            }
          }
        }
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true
    });

    return observer;
  },

  /**
   * Observe composer for content changes (to detect when cleared/sent)
   */
  observeComposer(callback) {
    const composer = this.getComposerElement();
    if (!composer) {
      console.warn('JAL: Could not find composer for observation');
      return null;
    }

    let lastContent = this.getComposerContent();
    const self = this;

    const observer = new MutationObserver(() => {
      const currentContent = self.getComposerContent();
      // Detect when content is cleared (was non-empty, now empty)
      if (lastContent && lastContent.length > 0 && (!currentContent || currentContent.length === 0)) {
        callback('cleared');
      }
      lastContent = currentContent;
    });

    observer.observe(composer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Also listen for input events
    composer.addEventListener('input', () => {
      const currentContent = self.getComposerContent();
      if (lastContent && lastContent.length > 0 && (!currentContent || currentContent.length === 0)) {
        callback('cleared');
      }
      lastContent = currentContent;
    });

    return observer;
  }
};

console.log('JAL ChatGPT Provider loaded');
