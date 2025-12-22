/**
 * JAL - Base Provider Adapter
 * Defines the interface all provider adapters must implement
 */

window.JAL = window.JAL || {};
window.JAL.Providers = window.JAL.Providers || {};

/**
 * Base class for provider adapters
 */
window.JAL.Providers.Base = {
  name: 'base',

  /**
   * Check if this provider is active on the current page
   */
  isActive() {
    return false;
  },

  /**
   * Get all assistant message elements on the page
   */
  getAssistantMessages() {
    return [];
  },

  /**
   * Find the message container element from a node
   */
  findMessageContainer(node) {
    return null;
  },

  /**
   * Check if an element is an assistant message (not user)
   */
  isAssistantMessage(element) {
    return false;
  },

  /**
   * Get the text content of a message
   */
  getMessageText(element) {
    return window.JAL.Utils.getTextContent(element);
  },

  /**
   * Get the chat input/composer element
   */
  getComposerElement() {
    return null;
  },

  /**
   * Insert text into the composer
   */
  insertIntoComposer(text) {
    const composer = this.getComposerElement();
    if (!composer) {
      console.warn('JAL: Could not find composer element');
      return false;
    }

    // For contenteditable
    if (composer.isContentEditable) {
      composer.focus();
      // Set text content
      composer.textContent = text;
      // Dispatch input event
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
      return true;
    }

    // For textarea/input
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      composer.focus();
      composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    return false;
  },

  /**
   * Get the container that holds all messages (for observing new messages)
   */
  getMessagesContainer() {
    return null;
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

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if this is a new assistant message
            const messages = this.isAssistantMessage(node)
              ? [node]
              : node.querySelectorAll ? [...node.querySelectorAll('*')].filter(el => this.isAssistantMessage(el)) : [];

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
   * Mark a message element for JAL tracking
   */
  markMessage(element) {
    if (!element.hasAttribute('data-jal-message')) {
      const fp = window.JAL.Utils.fingerprint(this.getMessageText(element));
      element.setAttribute('data-jal-message', fp);
      element.setAttribute('data-jal-provider', this.name);
    }
    return element.getAttribute('data-jal-message');
  }
};

console.log('JAL Base Provider loaded');
