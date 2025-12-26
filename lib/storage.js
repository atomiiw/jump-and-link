/**
 * JAL - Storage interface (communicates with background script)
 */

window.JAL = window.JAL || {};

window.JAL.Storage = {
  /**
   * Get all comments for the current page
   */
  async getComments(pageId) {
    console.log('JAL Storage: Getting comments for pageId:', pageId);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'GET_COMMENTS', pageId },
        (response) => {
          console.log('JAL Storage: Got response:', response);
          if (chrome.runtime.lastError) {
            console.error('JAL Storage: Chrome runtime error:', chrome.runtime.lastError);
          }
          resolve(response || []);
        }
      );
    });
  },

  /**
   * Save a new comment
   */
  async saveComment(comment) {
    console.log('JAL Storage: Saving comment:', comment.commentId, 'for pageId:', comment.pageId);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'SAVE_COMMENT', comment },
        (response) => {
          console.log('JAL Storage: Save response:', response);
          if (chrome.runtime.lastError) {
            console.error('JAL Storage: Chrome runtime error:', chrome.runtime.lastError);
          }
          resolve(response);
        }
      );
    });
  },

  /**
   * Update an existing comment
   */
  async updateComment(commentId, updates) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'UPDATE_COMMENT', commentId, updates },
        (response) => resolve(response)
      );
    });
  },

  /**
   * Delete a comment
   */
  async deleteComment(commentId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'DELETE_COMMENT', commentId },
        (response) => resolve(response)
      );
    });
  },

  /**
   * Get the jump stack for the current page
   */
  async getJumpStack(pageId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'GET_JUMP_STACK', pageId },
        (response) => resolve(response || [])
      );
    });
  },

  /**
   * Push a jump frame onto the stack
   */
  async pushJump(pageId, frame) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'PUSH_JUMP', pageId, frame },
        (response) => resolve(response)
      );
    });
  },

  /**
   * Pop a jump frame from the stack
   */
  async popJump(pageId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'POP_JUMP', pageId },
        (response) => resolve(response)
      );
    });
  },

  /**
   * Create a new comment object
   */
  createComment(pageId, anchor, body, options = {}) {
    return {
      commentId: window.JAL.Utils.generateId(),
      threadId: options.threadId || null,
      createdAt: Date.now(),
      pageId,
      anchor,
      body,
      status: options.status || 'draft',
      sendMode: options.sendMode || 'individual',
      selected: false
    };
  },

  /**
   * Create a jump frame
   */
  createJumpFrame(fromBlockFp, fromScrollY, threadIdsSent = []) {
    return {
      fromBlockFp,
      fromScrollY,
      toBlockFp: null,
      toScrollY: null,
      threadIdsSent,
      timestamp: Date.now()
    };
  }
};

console.log('JAL Storage loaded');
