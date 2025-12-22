/**
 * JAL - Claude Provider Adapter
 * Works with claude.ai
 */

window.JAL = window.JAL || {};
window.JAL.Providers = window.JAL.Providers || {};

window.JAL.Providers.claude = {
  name: 'claude',

  selectors: {
    // Claude's message containers
    messageContainer: [
      '[data-testid="assistant-message"]',
      '.font-claude-message',
      '[class*="Message"]'
    ],
    conversationArea: [
      'main',
      '[role="main"]'
    ],
    composer: [
      '[contenteditable="true"]',
      'div[contenteditable]',
      '.ProseMirror'
    ]
  },

  isActive() {
    return window.location.hostname.includes('claude.ai');
  },

  _findElement(selectorList) {
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  },

  getAssistantMessages() {
    // Try data attribute first
    let messages = document.querySelectorAll('[data-testid="assistant-message"]');
    if (messages.length > 0) return [...messages];

    // Claude uses alternating message pattern
    // Assistant messages typically have specific font/styling
    const allBlocks = document.querySelectorAll('[class*="Message"], [class*="message"]');
    return [...allBlocks].filter(el => {
      const text = el.textContent || '';
      return text.length > 50 && !el.querySelector('input, textarea');
    });
  },

  findMessageContainer(node) {
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

    while (current && current !== document.body) {
      if (current.hasAttribute('data-testid') &&
          current.getAttribute('data-testid').includes('message')) {
        return current;
      }
      if (current.hasAttribute('data-jal-message')) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  },

  isAssistantMessage(element) {
    const testId = element.getAttribute('data-testid');
    return testId?.includes('assistant');
  },

  getMessageText(element) {
    return window.JAL.Utils.getTextContent(element);
  },

  getComposerElement() {
    return this._findElement(this.selectors.composer);
  },

  insertIntoComposer(text) {
    const composer = this.getComposerElement();
    if (!composer) return false;

    composer.focus();

    if (composer.isContentEditable) {
      composer.textContent = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    return false;
  },

  getMessagesContainer() {
    return document.querySelector('main') || document.body;
  },

  getScrollPosition() {
    return window.scrollY;
  },

  scrollToPosition(position) {
    window.scrollTo({ top: position, behavior: 'smooth' });
  }
};

console.log('JAL Claude Provider loaded');
