// @vue/component
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { SSE } from "sse.js";

import Bot from "./Bot";
import store from "@/store";

// Inspired by https://v2ex.com/t/926890
const REFRESH_SESSION_URL =
  "https://chat.openai.com/_next/static/k9OKjvwgjWES7JT3k-6g9/_ssgManifest.js";
const REFRESH_SESSION_INTERVAL = 1000 * 45; // 45 seconds

export default class ChatGPTBot extends Bot {
  static _brandId = "ChatGPTBot";
  static _logoFilename = "chatgpt-logo.svg"; // Place it in assets/bots/
  static _loginUrl = "https://chat.openai.com/";
  static _model = "text-davinci-002-render-sha";

  accessToken = "";
  conversationContext = {
    conversationId: "",
    parentMessageId: "",
  };

  constructor() {
    super();
    this.constructor._model = store.state.chatgptModel;
  }

  async checkLoginStatus() {
    try {
      const response = await axios.get(
        "https://chat.openai.com/api/auth/session"
      );
      if (response.data && response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        this.constructor._isLoggedIn = true;
      } else {
        this.constructor._isLoggedIn = false;
      }
    } catch (error) {
      console.error("Error checking ChatGPT login status:", error);
      this.constructor._isLoggedIn = false;
    }
    // Toggle periodic session refreshing based on login status
    this.toggleSessionRefreshing(this.constructor._isLoggedIn);
  }

  refreshSession() {
    axios.get(REFRESH_SESSION_URL).catch((error) => {
      // the REFRESH_SESSION_URL always returns a 404 error
      // if 403, then the session has expired
      if (error.response && error.response.status === 403) {
        this.constructor._isLoggedIn = false;
        this.toggleSessionRefreshing(false);
      }
    });
  }

  toggleSessionRefreshing(shouldRefresh) {
    if (shouldRefresh && !this.sessionRefreshInterval) {
      this.refreshSession();
      this.sessionRefreshInterval = setInterval(
        this.refreshSession.bind(this),
        REFRESH_SESSION_INTERVAL
      );
    } else if (!shouldRefresh && this.sessionRefreshInterval) {
      clearInterval(this.sessionRefreshInterval);
      this.sessionRefreshInterval = null;
    }
  }

  async sendPrompt(prompt, onUpdateResponse, callbackParam) {
    // Make sure the access token is available
    if (!this.accessToken) await this.checkLoginStatus();

    // If not logged in, handle the error
    if (!this.isLoggedIn()) {
      console.error("Not logged in to ChatGPT.");
      return;
    }

    // Send the prompt to the ChatGPT API
    try {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      };
      const payload = JSON.stringify({
        action: "next",
        messages: [
          {
            id: uuidv4(),
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: [prompt],
            },
          },
        ],
        model: this.constructor._model,
        conversation_id: this.conversationContext.conversationId || undefined,
        parent_message_id: this.conversationContext.parentMessageId || uuidv4(),
      });

      const source = new SSE(
        "https://chat.openai.com/backend-api/conversation",
        { headers, payload }
      );
      source.addEventListener("message", (event) => {
        const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
        if (event.data === "[DONE]") {
          onUpdateResponse(null, callbackParam, true);
          source.close();
        } else if (regex.test(event.data)) {
          // Ignore the timestamp
          return;
        } else
          try {
            const data = JSON.parse(event.data);
            this.conversationContext.conversationId = data.conversation_id;
            this.conversationContext.parentMessageId = data.message.id;
            const partialText = data.message?.content?.parts?.[0];
            if (partialText) {
              onUpdateResponse(partialText, callbackParam, false);
            }
          } catch (error) {
            console.error("Error parsing ChatGPT response:", error);
            console.error("ChatGPT response:", event);
            return;
          }
      });
      source.addEventListener("error", (error) => {
        console.error("Error handling real-time updates:", error);
        onUpdateResponse(error.data.detail, callbackParam, true);
        source.close();
      });
      source.addEventListener("done", (event) => {
        console.log("done", event);
        source.close();
      });
      source.stream();
    } catch (error) {
      console.error("Error sending prompt to ChatGPT:", error);
    }
  }
}
