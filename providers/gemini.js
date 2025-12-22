/**
 * JAL - Gemini Provider Adapter
 * Works with gemini.google.com
 */

window.JAL = window.JAL || {};
window.JAL.Providers = window.JAL.Providers || {};

window.JAL.Providers.gemini = {
  name: 'gemini',

  selectors: {
    messageContainer: [
      'message-content',
      '[class*="response"]',
      '[class*="model-response"]'
    ],
    composer: [
      '.ql-editor',
      '[contenteditable="true"]',
      'textarea'
    ]
  },

  isActive() {
    return window.location.hostname.includes('gemini.google.com');
  },

  _findElement(selectorList) {
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  },

  getAssistantMessages() {
    // Gemini uses custom elements
    const messageContents = document.querySelectorAll('message-content');
    if (messageContents.length > 0) {
      return [...messageContents].filter((_, idx) => idx % 2 === 1);
    }

    // Fallback
    const responses = document.querySelectorAll('[class*="response"], [class*="model"]');
    return [...responses].filter(el => el.textContent.length > 50);
  },

  findMessageContainer(node) {
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

    while (current && current !== document.body) {
      if (current.tagName === 'MESSAGE-CONTENT') {
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
    return element.tagName === 'MESSAGE-CONTENT';
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
      composer.innerHTML = `<p>${text}</p>`;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    if (composer.tagName === 'TEXTAREA') {
      composer.value = text;
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

console.log('JAL Gemini Provider loaded');
